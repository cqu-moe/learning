"""Run the built CLI in a real PTY; test helper only."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

spec = json.loads(sys.argv[1])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, spec.get('columns', 80), 0, 0))
env = dict(os.environ, CI='', TERM=spec.get('term', 'xterm-256color'))
def attach_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    os.tcsetpgrp(0, os.getpgrp())

process = subprocess.Popen(spec['argv'], stdin=slave, stdout=slave, stderr=slave, env=env, preexec_fn=attach_terminal)
os.close(slave)
data = b''
step = 0
start = time.monotonic()
try:
    while time.monotonic() - start < 12:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                part = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not part:
                break
            data += part
        if step < len(spec.get('steps', [])):
            item = spec['steps'][step]
            if item['wait'] in data.decode('utf8', errors='replace'):
                if 'signal' in item:
                    process.send_signal(getattr(signal, item['signal']))
                else:
                    os.write(master, item['send'].encode())
                step += 1
        if process.poll() is not None and not ready:
            break
    if process.poll() is None:
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RuntimeError('PTY timeout: ' + data.decode('utf8', errors='replace'))
    print(json.dumps({'code': process.returncode, 'screen': data.decode('utf8', errors='replace'), 'steps': step}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
