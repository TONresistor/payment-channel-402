import "@stdlib/tvm-lowlevel"

// Cast a cell to a continuation for conditional execution
@pure
fun castToContinuation(c: continuation): (slice -> int)
    asm "NOP";
