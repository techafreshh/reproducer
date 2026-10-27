"""Vendored demo module for fixtures/demo-3 (demo/sleepywait#3).

Documents the "endless pause" bug the fixture replays: ``sleepwait``
sleeps past any reasonable deadline instead of pausing briefly, so a
bare ``sleepwait()`` never returns. The gate-graded ``repro.py`` inlines
this pair so the replay run stays offline and stdlib-only; nothing here
is imported at runtime.
"""

import time


def sleepwait(seconds=30):
    """Pause for ``seconds``; the buggy default never comes back in time."""
    time.sleep(seconds)
    return seconds


if __name__ == "__main__":
    sleepwait()
