import "@stdlib/gas-payments"

// ============================================================
// Global storage variables — 6-field balance model
// ============================================================
global inited: int;
global depositA: int;
global depositB: int;
global withdrawnA: int;
global withdrawnB: int;
global sentA: int;
global sentB: int;
global keyA: int;
global keyB: int;
global channelId: int;
global closureConfig: tuple;
global commitedSeqnoA: int;
global commitedSeqnoB: int;
global quarantine: cell?;
global paymentConfig: cell;
global unparsedStorage: slice;
global storageLevel: int;

// Storage parse levels
const STORAGE_MINIMAL = 0;
const STORAGE_WITH_SEQNOS = 1;
const STORAGE_FULL = 2;

// ============================================================
// ClosureConfig accessors (stored as tuple of 3)
// ============================================================
@pure
fun tTriple<X, Y, Z>(x: X, y: Y, z: Z): tuple
    asm "TRIPLE";

@inline
fun closureQuarantineDuration(): int {
    return closureConfig.first();
}
@inline
fun closureFine(): int {
    return closureConfig.get(1);
}
@inline
fun closureCloseDuration(): int {
    return closureConfig.get(2);
}

// ============================================================
// Balance computation: calcA/calcB
// ============================================================
@inline
fun calcA(): int {
    return depositA + sentB - sentA - withdrawnA;
}
@inline
fun calcB(): int {
    return depositB + sentA - sentB - withdrawnB;
}

// ============================================================
// Storage load / save
// ============================================================

// v2 storage layout (TL-B):
// channel$_ inited:Bool
//           balance:^Balance        — 6 coins fields
//           keyA:uint256 keyB:uint256
//           id:uint128
//           closureConfig:^ClosureConfig
//           commitedSeqnoA:uint64 commitedSeqnoB:uint64
//           quarantine:(Maybe ^Quarantine)
//           paymentConfig:^PaymentConfig

fun loadStorage(level: int) {
    storageLevel = level;
    var cs: slice = contract.getData().beginParse();
    inited = cs.loadInt(1);

    // Balance ref (6 fields)
    var bal: slice = cs.loadRef().beginParse();
    depositA = bal.loadCoins();
    depositB = bal.loadCoins();
    withdrawnA = bal.loadCoins();
    withdrawnB = bal.loadCoins();
    sentA = bal.loadCoins();
    sentB = bal.loadCoins();

    keyA = cs.loadUint(256);
    keyB = cs.loadUint(256);
    channelId = cs.loadUint(128);

    // ClosureConfig ref
    var conf: slice = cs.loadRef().beginParse();
    closureConfig = tTriple(conf.loadUint(32), conf.loadCoins(), conf.loadUint(32));

    if (level >= STORAGE_WITH_SEQNOS) {
        commitedSeqnoA = cs.loadUint(64);
        commitedSeqnoB = cs.loadUint(64);
        quarantine = cs.loadMaybeRef();
    }
    if (level >= STORAGE_FULL) {
        paymentConfig = cs.loadRef();
    }
    unparsedStorage = cs;
}

fun saveStorage() {
    var level: int = storageLevel;

    // Balance ref
    var balCell: cell = beginCell()
        .storeCoins(depositA)
        .storeCoins(depositB)
        .storeCoins(withdrawnA)
        .storeCoins(withdrawnB)
        .storeCoins(sentA)
        .storeCoins(sentB)
        .endCell();

    // ClosureConfig ref
    var confCell: cell = beginCell()
        .storeUint(closureQuarantineDuration(), 32)
        .storeCoins(closureFine())
        .storeUint(closureCloseDuration(), 32)
        .endCell();

    var storage: builder = beginCell()
        .storeInt(inited, 1)
        .storeRef(balCell)
        .storeUint(keyA, 256)
        .storeUint(keyB, 256)
        .storeUint(channelId, 128)
        .storeRef(confCell);

    if (level >= STORAGE_WITH_SEQNOS) {
        storage = storage
            .storeUint(commitedSeqnoA, 64)
            .storeUint(commitedSeqnoB, 64)
            .storeMaybeRef(quarantine);
    }
    if (level >= STORAGE_FULL) {
        storage = storage.storeRef(paymentConfig);
    } else {
        storage = storage.storeSlice(unparsedStorage);
    }

    contract.setData(storage.endCell());
}
