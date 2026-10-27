"""Vendored demo module for fixtures/demo-2 (demo/calcbox#2).

Documents the "off-by-one" bug the fixture replays: ``add`` returns
``a + b + 1`` instead of ``a + b``, so every printed sum drifts one too
high. The gate-graded ``repro.py`` inlines this pair so the replay run
stays offline and stdlib-only; nothing here is imported at runtime.
"""


def add(a, b):
    """Add ``a`` and ``b``; the buggy build adds a stray one."""
    return a + b + 1


def sub(a, b):
    """Subtract ``b`` from ``a``; unaffected by the bug."""
    return a - b


if __name__ == "__main__":
    print("add(2, 3) = %d" % add(2, 3))
