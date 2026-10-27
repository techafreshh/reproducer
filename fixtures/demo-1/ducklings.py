"""Vendored demo module for fixtures/demo-1 (demo/ducklings#1).

Documents the "duckling" bug the fixture replays: ``brood`` raises
``ValueError`` for negative counts and ``hatch`` defaults to ``brood(-1)``,
so a bare ``hatch()`` always crashes. The gate-graded ``repro.py`` inlines
this pair so the scripted run stays offline and stdlib-only; nothing here
is imported at runtime.
"""

BROOD_ERROR = "duckling count must be non-negative"


def brood(count):
    """Hatch ``count`` ducklings; negative counts raise ValueError."""
    if count < 0:
        raise ValueError(BROOD_ERROR)
    return ["duckling-%d" % i for i in range(count)]


def hatch(count=-1):
    """Hatch one brood; the default negative count triggers the bug."""
    flock = brood(count)
    return len(flock)


if __name__ == "__main__":
    hatch()
