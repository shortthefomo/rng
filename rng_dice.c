// Dice pot.
//
// A player escrows a native bet of at most 10 XAH to this hook account and
// puts the guessed face (1..6) in DestinationTag. The hook checks the bet,
// records it, and schedules a cron. It does not call dice() in that
// execution. featureRNG (xahaud PR 869) says a draw is safe from an
// outcome-based veto when the roll happens in a later transaction. The cron
// is that later transaction.
//
// When the cron fires, the hook draws dice(6), maps 0..5 onto faces 1..6, and
// waits for the escrow's time window:
//
//   loss, FinishAfter < last close time <= CancelAfter:
//     emit EscrowFinish. The stake is paid to this account (the pot).
//   win, last close time > CancelAfter:
//     emit EscrowCancel, which returns the stake, then emit a Payment of the
//     same amount from this account.
//   no entropy, or the loss window was missed:
//     emit EscrowCancel and pay nothing.
//
// fix1571 is what splits those windows. Finish is legal only until
// CancelAfter. Cancel is legal only after CancelAfter. One escrow can
// therefore still go either way, as long as the hook waits for the right
// close time.
//
// Install this hook with hsfCOLLECT (SetHook Flags 5; the ledger stores 4).
// A cron names its owner as a weak stakeholder. That execution also requires
// the account flag lsfTshCollect, set with AccountSet SetFlag 11
// (asfTshCollect). The hook flag alone does not run the cron.
//
// State key "BET", 44 bytes, one table at a time:
//   0  status   1 locked, 2 rolled, 3 finish sent, 4 cancel sent,
//              5 pay sent, 6 pay still owed
//   1  guess
//   2  face     0 until the roll
//   3  tries
//   4  drops    uint64 big-endian
//  12  finish   uint32 ripple time
//  16  cancel   uint32 ripple time
//  20  owner    20 bytes
//  40  sequence uint32 big-endian, the EscrowCreate sequence

#include "hookapi.h"

extern int64_t dice(uint32_t sides);

#ifndef TOO_LITTLE_ENTROPY
#define TOO_LITTLE_ENTROPY (-46)
#endif

#define HOOK_INLINE static inline __attribute__((always_inline))

#define MAX_BET 10000000ULL
#define MIN_LEAD 12U
#define MAX_LEAD 180U
#define MIN_GAP 20U
#define MAX_GAP 90U
#define CRON_DELAY 4U
#define CRON_SLACK 8U
#define FEE_BUFFER 1000000ULL

#define ST_LOCK 1U
#define ST_READY 2U
#define ST_FINISH 3U
#define ST_CANCEL 4U
#define ST_PAY 5U
#define ST_OWE 6U

#define REC_LEN 44U
#define R_STATUS 0
#define R_GUESS 1
#define R_FACE 2
#define R_TRIES 3
#define R_DROPS 4
#define R_FINISH 12
#define R_CANCEL 16
#define R_OWNER 20
#define R_SEQ 40

static const uint8_t BET_KEY[3] = {'B', 'E', 'T'};

#define FAIL(msg) return rollback((uint32_t)(msg), sizeof(msg) - 1, __LINE__)
#define OK(msg) return accept((uint32_t)(msg), sizeof(msg) - 1, __LINE__)

HOOK_INLINE uint32_t
get_u32(const uint8_t* p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
        ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

HOOK_INLINE uint64_t
get_u64(const uint8_t* p)
{
    return ((uint64_t)p[0] << 56) | ((uint64_t)p[1] << 48) |
        ((uint64_t)p[2] << 40) | ((uint64_t)p[3] << 32) |
        ((uint64_t)p[4] << 24) | ((uint64_t)p[5] << 16) |
        ((uint64_t)p[6] << 8) | (uint64_t)p[7];
}

HOOK_INLINE void
put_u32(uint8_t* p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

HOOK_INLINE void
put_u64(uint8_t* p, uint64_t v)
{
    p[0] = (uint8_t)(v >> 56);
    p[1] = (uint8_t)(v >> 48);
    p[2] = (uint8_t)(v >> 40);
    p[3] = (uint8_t)(v >> 32);
    p[4] = (uint8_t)(v >> 24);
    p[5] = (uint8_t)(v >> 16);
    p[6] = (uint8_t)(v >> 8);
    p[7] = (uint8_t)v;
}

// AccountID on the wire is a one-byte length of 20 followed by the id.
#define COPY20(d, s)                                                          \
    do                                                                        \
    {                                                                         \
        (d)[0] = (s)[0];                                                      \
        (d)[1] = (s)[1];                                                      \
        (d)[2] = (s)[2];                                                      \
        (d)[3] = (s)[3];                                                      \
        (d)[4] = (s)[4];                                                      \
        (d)[5] = (s)[5];                                                      \
        (d)[6] = (s)[6];                                                      \
        (d)[7] = (s)[7];                                                      \
        (d)[8] = (s)[8];                                                      \
        (d)[9] = (s)[9];                                                      \
        (d)[10] = (s)[10];                                                    \
        (d)[11] = (s)[11];                                                    \
        (d)[12] = (s)[12];                                                    \
        (d)[13] = (s)[13];                                                    \
        (d)[14] = (s)[14];                                                    \
        (d)[15] = (s)[15];                                                    \
        (d)[16] = (s)[16];                                                    \
        (d)[17] = (s)[17];                                                    \
        (d)[18] = (s)[18];                                                    \
        (d)[19] = (s)[19];                                                    \
    } while (0)

#define EQ20(a, b)                                                            \
    ((a)[0] == (b)[0] && (a)[1] == (b)[1] && (a)[2] == (b)[2] &&             \
     (a)[3] == (b)[3] && (a)[4] == (b)[4] && (a)[5] == (b)[5] &&             \
     (a)[6] == (b)[6] && (a)[7] == (b)[7] && (a)[8] == (b)[8] &&             \
     (a)[9] == (b)[9] && (a)[10] == (b)[10] && (a)[11] == (b)[11] &&         \
     (a)[12] == (b)[12] && (a)[13] == (b)[13] && (a)[14] == (b)[14] &&       \
     (a)[15] == (b)[15] && (a)[16] == (b)[16] && (a)[17] == (b)[17] &&       \
     (a)[18] == (b)[18] && (a)[19] == (b)[19])

HOOK_INLINE uint8_t*
put_fid(uint8_t* p, uint32_t field)
{
    uint32_t type = field >> 16;
    uint32_t nth = field & 0xFFFFU;
    if (type < 16 && nth < 16)
        *p++ = (uint8_t)((type << 4) | nth);
    else if (type < 16)
    {
        *p++ = (uint8_t)(type << 4);
        *p++ = (uint8_t)nth;
    }
    else if (nth < 16)
    {
        *p++ = (uint8_t)nth;
        *p++ = (uint8_t)type;
    }
    else
    {
        *p++ = 0;
        *p++ = (uint8_t)type;
        *p++ = (uint8_t)nth;
    }
    return p;
}

HOOK_INLINE uint8_t*
put_u16f(uint8_t* p, uint32_t field, uint16_t v)
{
    p = put_fid(p, field);
    *p++ = (uint8_t)(v >> 8);
    *p++ = (uint8_t)v;
    return p;
}

HOOK_INLINE uint8_t*
put_u32f(uint8_t* p, uint32_t field, uint32_t v)
{
    p = put_fid(p, field);
    put_u32(p, v);
    return p + 4;
}

HOOK_INLINE uint8_t*
put_acc(uint8_t* p, uint32_t field, const uint8_t acc[20])
{
    p = put_fid(p, field);
    *p++ = 20;
    COPY20(p, acc);
    return p + 20;
}

HOOK_INLINE uint8_t*
put_drops(uint8_t* p, uint64_t drops)
{
    p = put_fid(p, sfAmount);
    put_u64(p, drops | 0x4000000000000000ULL);
    return p + 8;
}

HOOK_INLINE int32_t
native_drops(const uint8_t raw[8], uint64_t* drops)
{
    uint64_t v = get_u64(raw);
    if ((v & 0x8000000000000000ULL) != 0)
        return 0;
    if ((v & 0x4000000000000000ULL) == 0)
        return 0;
    *drops = v & 0x3FFFFFFFFFFFFFFFULL;
    return 1;
}

HOOK_INLINE int64_t
save_rec(const uint8_t rec[REC_LEN])
{
    return state_set((uint32_t)rec, REC_LEN, (uint32_t)BET_KEY, 3);
}

HOOK_INLINE int64_t
load_rec(uint8_t rec[REC_LEN])
{
    return state((uint32_t)rec, REC_LEN, (uint32_t)BET_KEY, 3);
}

HOOK_INLINE int64_t
clear_rec(void)
{
    // A zero pointer and a zero length is the delete form of state_set.
    return state_set(0, 0, (uint32_t)BET_KEY, 3);
}

HOOK_INLINE int64_t
accept_face(uint8_t face, int kind)
{
    uint8_t m[16];
    m[0] = 'f';
    m[1] = 'a';
    m[2] = 'c';
    m[3] = 'e';
    m[4] = '=';
    m[5] = (uint8_t)('0' + face);
    m[6] = ' ';
    if (kind == 0)
    {
        m[7] = 'w';
        m[8] = 'i';
        m[9] = 'n';
        return accept((uint32_t)m, 10, __LINE__);
    }
    if (kind == 1)
    {
        m[7] = 'l';
        m[8] = 'o';
        m[9] = 's';
        m[10] = 's';
        return accept((uint32_t)m, 11, __LINE__);
    }
    m[7] = 'r';
    m[8] = 'e';
    m[9] = 'f';
    m[10] = 'u';
    m[11] = 'n';
    m[12] = 'd';
    return accept((uint32_t)m, 13, __LINE__);
}

// prepare() fills Account, Sequence, Fee, SigningPubKey, and EmitDetails.
// etxn_reserve(1) has to run first. One emit per execution.
HOOK_INLINE int64_t
emit_raw(uint8_t* raw, uint32_t raw_len)
{
    if (etxn_reserve(1) < 0)
        return EMISSION_FAILURE;

    uint8_t prepared[1024];
    int64_t plen = prepare((uint32_t)prepared, 1024, (uint32_t)raw, raw_len);
    if (plen < 0)
        return plen;

    uint8_t hash[32];
    return emit((uint32_t)hash, 32, (uint32_t)prepared, (uint32_t)plen);
}

HOOK_INLINE uint32_t
build_cron(uint8_t* p, uint32_t start, uint32_t reps)
{
    uint8_t* b = p;
    b = put_u16f(b, sfTransactionType, ttCRON_SET);
    b = put_u32f(b, sfStartTime, start);
    b = put_u32f(b, sfRepeatCount, reps);
    b = put_u32f(b, sfDelaySeconds, CRON_DELAY);
    return (uint32_t)(b - p);
}

HOOK_INLINE uint32_t
build_escrow(uint8_t* p, uint16_t tt, const uint8_t owner[20], uint32_t seq)
{
    uint8_t* b = p;
    b = put_u16f(b, sfTransactionType, tt);
    b = put_u32f(b, sfOfferSequence, seq);
    b = put_acc(b, sfOwner, owner);
    return (uint32_t)(b - p);
}

HOOK_INLINE uint32_t
build_pay(uint8_t* p, const uint8_t dest[20], uint64_t drops)
{
    uint8_t* b = p;
    b = put_u16f(b, sfTransactionType, ttPAYMENT);
    b = put_drops(b, drops);
    b = put_acc(b, sfDestination, dest);
    return (uint32_t)(b - p);
}

HOOK_INLINE int32_t
read_u32_field(uint32_t slot_no, uint32_t field, uint32_t child, uint32_t* out)
{
    if (slot_subfield(slot_no, field, child) < 0)
        return 0;
    uint8_t raw[8];
    int64_t n = slot((uint32_t)raw, 8, child);
    if (n == 4)
    {
        *out = get_u32(raw);
        return 1;
    }
    if (n == 8)
    {
        uint64_t drops = 0;
        if (!native_drops(raw, &drops) || drops > 0xFFFFFFFFULL)
            return 0;
        *out = (uint32_t)drops;
        return 1;
    }
    return 0;
}

// balance >= reserve(ownerCount + 2) + bet + 1 XAH.
// The extra two owner objects are this bet's state and its cron.
HOOK_INLINE int32_t
pot_can_pay(uint64_t bet)
{
    uint8_t me[20];
    if (hook_account((uint32_t)me, 20) != 20)
        return 0;

    uint8_t kl[34];
    if (util_keylet((uint32_t)kl, 34, KEYLET_ACCOUNT, (uint32_t)me, 20, 0, 0, 0, 0) !=
        34)
        return 0;
    if (slot_set((uint32_t)kl, 34, 1) < 0)
        return 0;

    if (slot_subfield(1, sfBalance, 2) < 0)
        return 0;
    uint8_t raw[8];
    if (slot((uint32_t)raw, 8, 2) != 8)
        return 0;
    uint64_t balance = 0;
    if (!native_drops(raw, &balance))
        return 0;

    uint32_t owners = 0;
    if (!read_u32_field(1, sfOwnerCount, 3, &owners))
        return 0;

    if (util_keylet((uint32_t)kl, 34, KEYLET_FEES, 0, 0, 0, 0, 0, 0) != 34)
        return 0;
    if (slot_set((uint32_t)kl, 34, 4) < 0)
        return 0;

    uint32_t base = 0;
    uint32_t step = 0;
    if (!read_u32_field(4, sfReserveBaseDrops, 5, &base) &&
        !read_u32_field(4, sfReserveBase, 5, &base))
        return 0;
    if (!read_u32_field(4, sfReserveIncrementDrops, 6, &step) &&
        !read_u32_field(4, sfReserveIncrement, 6, &step))
        return 0;

    uint64_t reserve =
        (uint64_t)base + (uint64_t)step * ((uint64_t)owners + 2ULL);
    uint64_t need = reserve + bet + FEE_BUFFER;
    trace_num((uint32_t) "pot", 3, (int64_t)balance);
    trace_num((uint32_t) "need", 4, (int64_t)need);
    return balance >= need;
}

HOOK_INLINE uint32_t
cron_reps(uint32_t now, uint32_t cancel_after)
{
    uint32_t span = cancel_after > now ? cancel_after - now : 0;
    uint32_t reps = span / CRON_DELAY + 6U;
    if (reps < 4U)
        reps = 4U;
    if (reps > 80U)
        reps = 80U;
    return reps;
}

HOOK_INLINE int64_t
emit_cron(const uint8_t rec[REC_LEN])
{
    uint32_t now = (uint32_t)ledger_last_time();
    uint32_t cancel_after = get_u32(rec + R_CANCEL);
    uint8_t raw[64];
    uint32_t n = build_cron(raw, now + CRON_SLACK, cron_reps(now, cancel_after));
    return emit_raw(raw, n);
}

HOOK_INLINE int64_t
emit_escrow(uint16_t tt, const uint8_t rec[REC_LEN])
{
    uint8_t raw[64];
    uint32_t n = build_escrow(raw, tt, rec + R_OWNER, get_u32(rec + R_SEQ));
    return emit_raw(raw, n);
}

HOOK_INLINE int64_t
emit_prize(const uint8_t rec[REC_LEN])
{
    uint8_t raw[64];
    uint32_t n = build_pay(raw, rec + R_OWNER, get_u64(rec + R_DROPS));
    return emit_raw(raw, n);
}

HOOK_INLINE int64_t
on_create(void)
{
    uint8_t me[20];
    uint8_t acc[20];
    uint8_t dest[20];
    if (hook_account((uint32_t)me, 20) != 20)
        FAIL("hook account");
    if (otxn_field((uint32_t)acc, 20, sfAccount) != 20)
        OK("pass");
    if (otxn_field((uint32_t)dest, 20, sfDestination) != 20)
        OK("pass");
    if (EQ20(acc, me) || !EQ20(dest, me))
        OK("pass");

    uint8_t existing[REC_LEN];
    int64_t have = load_rec(existing);
    if (have == REC_LEN)
        FAIL("table busy");
    if (have != DOESNT_EXIST)
        FAIL("state");

    uint8_t amt[8];
    int64_t amt_len = otxn_field((uint32_t)amt, 8, sfAmount);
    if (amt_len != 8)
        FAIL("xah only");
    uint64_t drops = 0;
    if (!native_drops(amt, &drops) || drops == 0)
        FAIL("xah only");
    if (drops > MAX_BET)
        FAIL("max 10 xah");

    uint8_t tag[4];
    if (otxn_field((uint32_t)tag, 4, sfDestinationTag) != 4)
        FAIL("guess 1-6");
    uint32_t guess = get_u32(tag);
    if (guess < 1 || guess > 6)
        FAIL("guess 1-6");

    uint8_t tbuf[4];
    if (otxn_field((uint32_t)tbuf, 4, sfFinishAfter) != 4)
        FAIL("time window");
    uint32_t finish_after = get_u32(tbuf);
    if (otxn_field((uint32_t)tbuf, 4, sfCancelAfter) != 4)
        FAIL("time window");
    uint32_t cancel_after = get_u32(tbuf);

    uint32_t now = (uint32_t)ledger_last_time();
    if (finish_after < now + MIN_LEAD || finish_after > now + MAX_LEAD)
        FAIL("time window");
    if (cancel_after < finish_after + MIN_GAP ||
        cancel_after > finish_after + MAX_GAP)
        FAIL("time window");

    if (!pot_can_pay(drops))
        FAIL("pot short");

    uint8_t seqb[4];
    if (otxn_field((uint32_t)seqb, 4, sfSequence) != 4)
        FAIL("sequence");

    uint8_t rec[REC_LEN];
    rec[R_STATUS] = ST_LOCK;
    rec[R_GUESS] = (uint8_t)guess;
    rec[R_FACE] = 0;
    rec[R_TRIES] = 0;
    put_u64(rec + R_DROPS, drops);
    put_u32(rec + R_FINISH, finish_after);
    put_u32(rec + R_CANCEL, cancel_after);
    COPY20(rec + R_OWNER, acc);
    rec[R_SEQ] = seqb[0];
    rec[R_SEQ + 1] = seqb[1];
    rec[R_SEQ + 2] = seqb[2];
    rec[R_SEQ + 3] = seqb[3];

    if (save_rec(rec) < 0)
        FAIL("state");

    trace_num((uint32_t) "guess", 5, (int64_t)guess);
    trace_num((uint32_t) "drops", 5, (int64_t)drops);

    if (emit_cron(rec) < 0)
        FAIL("cron");

    OK("locked");
}

HOOK_INLINE int64_t
on_tick(void)
{
    uint8_t rec[REC_LEN];
    int64_t have = load_rec(rec);
    if (have == DOESNT_EXIST)
        OK("idle");
    if (have != REC_LEN)
        OK("state");

    uint32_t now = (uint32_t)ledger_last_time();
    uint32_t finish_after = get_u32(rec + R_FINISH);
    uint32_t cancel_after = get_u32(rec + R_CANCEL);

    if (rec[R_STATUS] == ST_OWE)
    {
        if (emit_prize(rec) < 0)
            OK("pay fail");
        rec[R_STATUS] = ST_PAY;
        if (save_rec(rec) < 0)
            OK("state");
        OK("paid");
    }

    if (rec[R_STATUS] == ST_FINISH || rec[R_STATUS] == ST_CANCEL ||
        rec[R_STATUS] == ST_PAY)
        OK("inflight");

    if (rec[R_FACE] == 0)
    {
        int64_t roll = dice(6);
        trace_num((uint32_t) "roll", 4, roll);
        if (roll == TOO_LITTLE_ENTROPY || roll < 0)
        {
            if (rec[R_TRIES] < 255)
                rec[R_TRIES]++;
            save_rec(rec);
            if (rec[R_TRIES] > 12 && now > cancel_after)
            {
                if (emit_escrow(ttESCROW_CANCEL, rec) < 0)
                    OK("entropy");
                rec[R_STATUS] = ST_CANCEL;
                save_rec(rec);
                OK("entropy");
            }
            OK("entropy");
        }
        if (roll > 5)
            OK("dice");
        rec[R_FACE] = (uint8_t)(roll + 1);
        rec[R_STATUS] = ST_READY;
        if (save_rec(rec) < 0)
            OK("state");
    }

    int win = rec[R_FACE] == rec[R_GUESS];
    trace_num((uint32_t) "face", 4, (int64_t)rec[R_FACE]);

    if (win)
    {
        if (now <= cancel_after)
            OK("wait");
        if (emit_escrow(ttESCROW_CANCEL, rec) < 0)
            OK("emit fail");
        rec[R_STATUS] = ST_CANCEL;
        save_rec(rec);
        return accept_face(rec[R_FACE], 0);
    }

    if (now > finish_after && now <= cancel_after)
    {
        if (emit_escrow(ttESCROW_FINISH, rec) < 0)
            OK("emit fail");
        rec[R_STATUS] = ST_FINISH;
        save_rec(rec);
        return accept_face(rec[R_FACE], 1);
    }

    if (now > cancel_after)
    {
        if (emit_escrow(ttESCROW_CANCEL, rec) < 0)
            OK("emit fail");
        rec[R_STATUS] = ST_CANCEL;
        save_rec(rec);
        return accept_face(rec[R_FACE], 2);
    }

    OK("wait");
}

int64_t
cbak(uint32_t ctx)
{
    // The guard checker requires the _g import even when there is no loop.
    (void)_g(1, 1);

    uint8_t rec[REC_LEN];
    int64_t have = load_rec(rec);
    if (have == DOESNT_EXIST)
        OK("idle");
    if (have != REC_LEN)
        OK("state");

    int64_t tt = otxn_type();

    if (ctx == 1)
    {
        if (tt == ttCRON_SET && rec[R_STATUS] == ST_LOCK)
        {
            if (emit_cron(rec) < 0)
                OK("cron fail");
            OK("cron retry");
        }
        if (tt == ttPAYMENT &&
            (rec[R_STATUS] == ST_PAY || rec[R_STATUS] == ST_OWE))
        {
            rec[R_STATUS] = ST_OWE;
            save_rec(rec);
            OK("pay retry");
        }
        if (tt == ttESCROW_FINISH || tt == ttESCROW_CANCEL)
        {
            rec[R_STATUS] = ST_READY;
            save_rec(rec);
            OK("retry");
        }
        OK("fail");
    }

    if (tt == ttCRON_SET)
        OK("armed");

    if (tt == ttESCROW_FINISH && rec[R_STATUS] == ST_FINISH)
    {
        clear_rec();
        OK("done");
    }

    if (tt == ttESCROW_CANCEL && rec[R_STATUS] == ST_CANCEL)
    {
        if (rec[R_FACE] != 0 && rec[R_FACE] == rec[R_GUESS])
        {
            if (emit_prize(rec) < 0)
            {
                rec[R_STATUS] = ST_OWE;
                save_rec(rec);
                OK("pay fail");
            }
            rec[R_STATUS] = ST_PAY;
            save_rec(rec);
            OK("paid");
        }
        clear_rec();
        OK("done");
    }

    if (tt == ttPAYMENT && rec[R_STATUS] == ST_PAY)
    {
        clear_rec();
        OK("done");
    }

    OK("cbak");
}

int64_t
hook(uint32_t reserved)
{
    (void)reserved;
    // The guard checker requires the _g import even when there is no loop.
    (void)_g(1, 1);
    int64_t tt = otxn_type();
    if (tt == ttESCROW_CREATE)
        return on_create();
    if (tt == ttCRON || tt == ttINVOKE)
        return on_tick();
    OK("pass");
}
