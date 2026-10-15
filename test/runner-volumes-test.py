"""A kötettakarító valós folyamatjelekkel, izolált Docker- és discovery-határral."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(sys.argv.pop(1)).resolve()


class VolumeGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='volume-guard-test-')
        self.root = Path(self.tmp.name)
        self.listener = subprocess.Popen(['sleep', '120'])
        self.env = dict(os.environ, HOME=str(self.root), STATE=str(self.root),
                        DISK_GUARD_EVENT_LOG=str(self.root / 'events'),
                        DISK_GUARD_VOLUME_WAIT_SECONDS='0')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env['PATH'] = f'{self.bin}:/usr/bin:/bin'
        self.write('listeners', str(self.listener.pid))
        self.write('workers', '')
        self.stub('pgrep', '''case "$*" in
          *Worker*) cat "$STATE/workers"; [ -s "$STATE/workers" ] ;;
          *Listener*) cat "$STATE/listeners"; [ -s "$STATE/listeners" ] ;;
          *) exit 2;;
        esac''')
        self.stub('df', 'echo "Avail"; echo "${FREE_MB:-7000}M"')
        self.stub('docker', '''echo "$*" >> "$STATE/docker-calls"
          [ "$*" = "volume prune --force" ] || exit 91
          state=$(ps -o stat= -p "$(cat "$STATE/listeners")")
          case "$state" in *T*) ;; *) exit 92;; esac
          [ ! -s "$STATE/workers" ] || exit 93
          echo "Total reclaimed space: 14GB"
          exit "${DOCKER_EXIT:-0}"
        ''')

    def write(self, name, text):
        (self.root / name).write_text(text)

    def stub(self, name, body):
        p = self.bin / name
        p.write_text('#!/bin/bash\n' + body + '\n')
        p.chmod(0o755)

    def run_guard(self, **env):
        r = subprocess.run(['bash', '-e', str(SCRIPT), str(self.root)],
                           env=dict(self.env, **env), capture_output=True, text=True, timeout=8)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return (self.root / 'events').read_text() if (self.root / 'events').exists() else ''

    def assert_resumed(self):
        state = subprocess.check_output(['ps', '-o', 'stat=', '-p', str(self.listener.pid)], text=True)
        self.assertNotIn('T', state)

    def assert_no_prune(self):
        self.assertFalse((self.root / 'docker-calls').exists())
        self.assert_resumed()

    def tearDown(self):
        self.listener.send_signal(signal.SIGCONT)
        self.listener.terminate()
        self.listener.wait(timeout=3)
        self.tmp.cleanup()

    def test_prunes_only_volumes_and_resumes_listener(self):
        events = self.run_guard()
        self.assertEqual((self.root / 'docker-calls').read_text(), 'volume prune --force\n')
        self.assertIn('volume_prune', events)
        self.assertIn('14GB', events)
        self.assert_resumed()

    def test_busy_worker_skips_everything_including_listener_pause(self):
        self.write('workers', '12345')
        self.run_guard()
        self.assert_no_prune()

    def test_worker_appearing_after_first_check_is_caught(self):
        self.stub('pgrep', '''case "$*" in
          *Worker*)
            if [ -e "$STATE/checked" ]; then echo 12345; exit 0; fi
            touch "$STATE/checked"; exit 1 ;;
          *Listener*) cat "$STATE/listeners" ;;
        esac''')
        self.run_guard()
        self.assert_no_prune()

    def test_discovery_error_is_not_idle(self):
        self.stub('pgrep', 'exit 2')
        self.run_guard()
        self.assert_no_prune()

    def test_missing_listener_skips(self):
        self.write('listeners', '')
        self.run_guard()
        self.assert_no_prune()

    def test_already_stopped_listener_is_not_resumed_by_us(self):
        self.listener.send_signal(signal.SIGSTOP)
        self.run_guard()
        self.assertFalse((self.root / 'docker-calls').exists())
        state = subprocess.check_output(['ps', '-o', 'stat=', '-p', str(self.listener.pid)], text=True)
        self.assertIn('T', state)

    def test_sufficient_space_skips(self):
        self.run_guard(FREE_MB='16000')
        self.assert_no_prune()

    def test_unreadable_space_skips(self):
        self.stub('df', 'exit 1')
        self.run_guard()
        self.assert_no_prune()

    def test_docker_failure_is_logged_and_listener_resumed(self):
        events = self.run_guard(DOCKER_EXIT='1')
        self.assertIn('volume_prune_failed', events)
        self.assert_resumed()

    def test_lock_contention_skips(self):
        (self.root / 'runner-hooks').mkdir()
        with open(self.root / 'runner-hooks/disk-guard-volumes.lock', 'w') as lock:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.run_guard()
        self.assert_no_prune()

    def test_second_listener_failure_resumes_first(self):
        self.write('listeners', f'{self.listener.pid}\n99999999')
        self.run_guard()
        self.assert_no_prune()

    def test_hook_preserves_old_checkout_and_returns_before_worker_exits(self):
        import time
        checkout = self.root / 'work' / 'old-repo'
        checkout.mkdir(parents=True)
        (checkout / 'keep').write_text('checkout')
        for entry in [checkout / 'keep', checkout]:
            os.utime(entry, (time.time() - 30 * 86400,) * 2)
        self.write('workers', '12345')
        self.stub('df', 'case "$*" in *-BG*) echo 7G;; *) echo 20000M;; esac')
        started = time.monotonic()
        r = subprocess.run(['bash', '-e', str(SCRIPT.with_name('disk-guard.sh'))],
                           env=dict(self.env, RUNNER_WORKSPACE=str(checkout)),
                           capture_output=True, text=True, timeout=3)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertLess(time.monotonic() - started, 2)
        self.assertIn('kötettakarítás ütemezve', r.stdout)
        self.assertTrue((checkout / 'keep').exists())
        self.assert_no_prune()

    def test_signal_resumes_listener(self):
        self.stub('docker', 'touch "$STATE/pruning"; sleep 120')
        p = subprocess.Popen(['bash', '-e', str(SCRIPT), str(self.root)],
                             env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        import time
        try:
            for _ in range(200):
                if (self.root / 'pruning').exists():
                    break
                time.sleep(0.01)
            self.assertTrue((self.root / 'pruning').exists())
            os.killpg(p.pid, signal.SIGTERM)
            self.assertEqual(p.wait(timeout=3), 0)
            self.assert_resumed()
        finally:
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()


if __name__ == '__main__':
    unittest.main()
