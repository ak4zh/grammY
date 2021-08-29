// deno-lint-ignore-file camelcase no-explicit-any
import { AliasProps, Context } from './context.ts'
import { Update } from './platform.ts'

type FilterFunction<C extends Context, D extends C> = (ctx: C) => ctx is D

// === Obtain O(1) filter function from query
/**
 * > This is an advanced function of grammY.
 *
 * Takes a filter query and turns it into a predicate function that can check in
 * constant time whether a given context object satisfies the query. The created
 * predicate can be passed to `bot.filter` and will narrow down the context
 * accordingly.
 *
 * This function is used internally by `bot.on` but exposed for advanced usage
 * like the following.
 * ```ts
 * // Listens for all messages and channel posts except forwards
 * `bot.drop(matchFilter(':forward_date'), ctx => { ... })
 * ```
 *
 * Check out the
 * [documentation](https://doc.deno.land/https/deno.land/x/grammy/mod.ts#Composer)
 * of `bot.on` for examples. In addition, the
 * [website](https://grammy.dev/guide/filter-queries.html) contains more
 * information about how filter queries work in grammY.
 *
 * @param filter A filter query or an array of filter queries
 */
export function matchFilter<C extends Context, Q extends FilterQuery>(
    filter: Q | Q[]
): FilterFunction<C, Filter<C, Q>> {
    const parsed = parse(filter)
    const predicate = compile(parsed)
    return (ctx: C): ctx is Filter<C, Q> => predicate(ctx)
}

function parse(filter: FilterQuery | FilterQuery[]): string[][] {
    return Array.isArray(filter)
        ? filter.map(q => q.split(':'))
        : [filter.split(':')]
}

function compile(parsed: string[][]): (ctx: Context) => boolean {
    const preprocessed = parsed.flatMap(q => check(q, preprocess(q)))
    const ltree = treeify(preprocessed)
    const predicate = arborist(ltree) // arborists check trees
    return ctx => !!predicate(ctx.update, ctx)
}

function preprocess(filter: string[]): string[][] {
    const valid: any = UPDATE_KEYS
    const expanded = [filter]
        // expand L1
        .flatMap(q => {
            const [l1, l2, l3] = q
            // only expand if shortcut is given
            if (!(l1 in L1_SHORTCUTS)) return [q]
            // only expand for at least one non-empty part
            if (!l1 && !l2 && !l3) return [q]
            // perform actual expansion
            const targets = L1_SHORTCUTS[l1 as L1Shortcuts]
            const expanded = targets.map(s => [s, l2, l3])
            // assume that bare L1 expansions are always correct
            if (l2 === undefined) return expanded
            // only filter out invalid expansions if we don't do this later
            if (l2 in L2_SHORTCUTS && (l2 || l3)) return expanded
            // filter out invalid expansions, e.g. `channel_post:new_chat_member` for empty L1
            return expanded.filter(([s]) => !!valid[s]?.[l2])
        })
        // expand L2
        .flatMap(q => {
            const [l1, l2, l3] = q
            // only expand if shortcut is given
            if (!(l2 in L2_SHORTCUTS)) return [q]
            // only expand for at least one non-empty part
            if (!l2 && !l3) return [q]
            // perform actual expansion
            const targets = L2_SHORTCUTS[l2 as L2Shortcuts]
            const expanded = targets.map(s => [l1, s, l3])
            // assume that bare L2 expansions are always correct
            if (l3 === undefined) return expanded
            // filter out invalid expansions
            return expanded.filter(([, s]) => !!valid[l1]?.[s]?.[l3])
        })
    if (expanded.length === 0)
        throw new Error(
            `Shortcuts in ${filter.join(
                ':'
            )} do not expand to any valid filter query`
        )
    return expanded
}

function check(original: string[], preprocessed: string[][]): string[][] {
    if (preprocessed.length === 0) throw new Error('Empty filter query given')
    const errors = preprocessed
        .map(checkOne)
        .filter((r): r is string => r !== true)
    if (errors.length === 0) return preprocessed
    else if (errors.length === 1) throw new Error(errors[0])
    else
        throw new Error(
            `Invalid filter query '${original.join(':')}'. There are ${
                errors.length
            } errors after expanding the contained shortcuts: ${errors.join(
                '; '
            )}`
        )
}
function checkOne(filter: string[]): string | true {
    const [l1, l2, l3, ...n] = filter
    if (l1 === undefined) return 'Empty filter query given'
    if (!(l1 in UPDATE_KEYS)) {
        const permitted = Object.keys(UPDATE_KEYS)
        return `Invalid L1 filter '${l1}' given in '${filter.join(':')}'. \
Permitted values are: ${permitted.map(k => `'${k}'`).join(', ')}.`
    }
    if (l2 === undefined) return true
    const l1Obj: any = UPDATE_KEYS[l1 as keyof S]
    if (!(l2 in l1Obj)) {
        const permitted = Object.keys(l1Obj)
        return `Invalid L2 filter '${l2}' given in '${filter.join(':')}'. \
Permitted values are: ${permitted.map(k => `'${k}'`).join(', ')}.`
    }
    if (l3 === undefined) return true
    const l2Obj = l1Obj[l2]
    if (!(l3 in l2Obj)) {
        const permitted = Object.keys(l2Obj)
        return `Invalid L3 filter '${l3}' given in '${filter.join(':')}'. ${
            permitted.length === 0
                ? `No further filtering is possible after '${l1}:${l2}'.`
                : `Permitted values are: ${permitted
                      .map(k => `'${k}'`)
                      .join(', ')}.`
        }`
    }
    if (n.length === 0) return true
    return `Cannot filter further than three levels, ':${n.join(
        ':'
    )}' is invalid!`
}

interface LTree {
    [l1: string]: {
        [l2: string]: Set<string>
    }
}
function treeify(paths: string[][]): LTree {
    const tree: LTree = {}
    for (const [l1, l2, l3] of paths) {
        const subtree = (tree[l1] ??= {})
        if (l2 !== undefined) {
            const set = (subtree[l2] ??= new Set())
            if (l3 !== undefined) set.add(l3)
        }
    }
    return tree
}

type Pred = (obj: any, ctx: Context) => boolean
function or(left: Pred, right: Pred): Pred {
    return (obj, ctx) => left(obj, ctx) || right(obj, ctx)
}
function concat(get: Pred, test: Pred): Pred {
    return (obj, ctx) => {
        const nextObj = get(obj, ctx)
        return nextObj && test(nextObj, ctx)
    }
}
function leaf(pred: Pred): Pred {
    return (obj, ctx) => pred(obj, ctx) != null
}
function arborist(tree: LTree): Pred {
    const l1Predicates = Object.entries(tree).map(([l1, subtree]) => {
        const l1Pred: Pred = obj => obj[l1]
        const l2Predicates = Object.entries(subtree).map(([l2, set]) => {
            const l2Pred: Pred = obj => obj[l2]
            const l3Predicates = Array.from(set).map(l3 => {
                const l3Pred: Pred =
                    l3 === 'me' // special handling for `me` shortcut
                        ? (obj, ctx) => {
                              const me = ctx.me.id
                              return testMaybeArray(obj, u => u.id === me)
                          }
                        : obj =>
                              testMaybeArray(obj, e => e[l3] || e.type === l3)
                return l3Pred
            })
            return l3Predicates.length === 0
                ? leaf(l2Pred)
                : concat(l2Pred, l3Predicates.reduce(or))
        })
        return l2Predicates.length === 0
            ? leaf(l1Pred)
            : concat(l1Pred, l2Predicates.reduce(or))
    })
    if (l1Predicates.length === 0)
        throw new Error('Cannot create filter function for empty query')
    return l1Predicates.reduce(or)
}

function testMaybeArray<T>(t: T | T[], pred: (t: T) => boolean): boolean {
    const p = (x: T) => x != null && pred(x)
    return Array.isArray(t) ? t.some(p) : p(t)
}

// === Define a structure to validate the queries
// L3
const ENTITY_KEYS = {
    mention: {},
    hashtag: {},
    cashtag: {},
    bot_command: {},
    url: {},
    email: {},
    phone_number: {},
    bold: {},
    italic: {},
    underline: {},
    strikethrough: {},
    code: {},
} as const
const USER_KEYS = {
    me: {},
    is_bot: {},
} as const

// L2
const EDITABLE_MESSAGE_KEYS = {
    text: {},
    animation: {},
    audio: {},
    document: {},
    photo: {},
    video: {},
    game: {},
    location: {},

    entities: ENTITY_KEYS,
    caption_entities: ENTITY_KEYS,

    caption: {},
} as const
const COMMON_MESSAGE_KEYS = {
    ...EDITABLE_MESSAGE_KEYS,

    sticker: {},
    video_note: {},
    voice: {},
    contact: {},
    dice: {},
    poll: {},
    venue: {},

    new_chat_title: {},
    new_chat_photo: {},
    delete_chat_photo: {},
    message_auto_delete_timer_changed: {},
    pinned_message: {},
    invoice: {},
    proximity_alert_triggered: {},
    voice_chat_scheduled: {},
    voice_chat_started: {},
    voice_chat_ended: {},
    voice_chat_participants_invited: {},

    forward_date: {},
} as const
const MESSAGE_KEYS = {
    ...COMMON_MESSAGE_KEYS,
    new_chat_members: USER_KEYS,
    left_chat_member: USER_KEYS,
    group_chat_created: {},
    supergroup_chat_created: {},
    migrate_to_chat_id: {},
    migrate_from_chat_id: {},
    successful_payment: {},
    connected_website: {},
    passport_data: {},
} as const
const CHANNEL_POST_KEYS = {
    ...COMMON_MESSAGE_KEYS,
    channel_chat_created: {},
} as const
const CALLBACK_QUERY_KEYS = { data: {}, game_short_name: {} } as const
const CHAT_MEMBER_UPDATED_KEYS = { from: USER_KEYS } as const

// L1
const UPDATE_KEYS = {
    message: MESSAGE_KEYS,
    edited_message: MESSAGE_KEYS,
    channel_post: CHANNEL_POST_KEYS,
    edited_channel_post: CHANNEL_POST_KEYS,
    inline_query: {},
    chosen_inline_result: {},
    callback_query: CALLBACK_QUERY_KEYS,
    shipping_query: {},
    pre_checkout_query: {},
    poll: {},
    poll_answer: {},
    my_chat_member: CHAT_MEMBER_UPDATED_KEYS,
    chat_member: CHAT_MEMBER_UPDATED_KEYS,
} as const

// === Build up all possible filter queries from the above validation structure
type KeyOf<T> = string & keyof T // Emulate `keyofStringsOnly`

type S = typeof UPDATE_KEYS

// E.g. 'message'
type L1 = KeyOf<S>
// E.g. 'message:entities'
type L2<K extends L1 = L1> = K extends unknown ? `${K}:${KeyOf<S[K]>}` : never
// E.g. 'message:entities:url'
type L3<K0 extends L1 = L1> = K0 extends unknown ? L3_<K0> : never
type L3_<
    K0 extends L1,
    K1 extends KeyOf<S[K0]> = KeyOf<S[K0]>
> = K1 extends unknown ? `${K0}:${K1}:${KeyOf<S[K0][K1]>}` : never
// All three combined
type L123 = L1 | L2 | L3
// E.g. 'message::url'
type InjectShortcuts<Q extends L123 = L123> =
    Q extends `${infer R}:${infer S}:${infer T}`
        ? `${CollapseL1<R, L1Shortcuts>}:${CollapseL2<S, L2Shortcuts>}:${T}`
        : Q extends `${infer R}:${infer S}`
        ? `${CollapseL1<R, L1Shortcuts>}:${CollapseL2<S>}`
        : CollapseL1<Q>
// Add L1 shortcuts
type CollapseL1<
    Q extends string,
    L extends L1Shortcuts = Exclude<L1Shortcuts, ''>
> =
    | Q
    | (L extends string
          ? Q extends typeof L1_SHORTCUTS[L][number]
              ? L
              : never
          : never)
// Add L2 shortcuts
type CollapseL2<
    Q extends string,
    L extends L2Shortcuts = Exclude<L2Shortcuts, ''>
> =
    | Q
    | (L extends string
          ? Q extends typeof L2_SHORTCUTS[L][number]
              ? L
              : never
          : never)
// All queries
type AllValidFilterQueries = InjectShortcuts

/**
 * Represents a filter query that can be passed to `bot.on`. There are three
 * different kinds of filter queries: Level 1, Level 2, and Level 3. Check out
 * the [website](https://grammy.dev/guide/filter-queries.html) to read about how
 * filter queries work in grammY, and how to use them.
 *
 * Here are three brief examples:
 * ```ts
 * // Listen for messages of any type (Level 1)
 * bot.on('message', ctx => { ... })
 * // Listen for audio messages only (Level 2)
 * bot.on('message:audio', ctx => { ... })
 * // Listen for text messages that have a URL entity (Level 3)
 * bot.on('message:entities:url', ctx => { ... })
 * ```
 */
export type FilterQuery = AllValidFilterQueries

// === Infer the present/absent properties on a context object based on a query
// Note: L3 filters are not represented in types

/**
 * Any kind of value that appears in the Telegram Bot API. When intersected with
 * an optional field, it effectively removes `| undefined`.
 */
// deno-lint-ignore ban-types
type SomeObject = object
type NotUndefined = string | number | boolean | SomeObject

/**
 * Given a FilterQuery, returns an object that, when intersected with an Update,
 * marks those properties as required that are guaranteed to exist.
 */
type RunQuery<Q extends string> = L1Combinations<Q, L1Parts<Q>>

// build up all combinations of all L1 fields
type L1Combinations<Q extends string, L1 extends string> = Combine<
    L1Fields<Q, L1>,
    L1
>
// maps each L1 part of the filter query to an object
type L1Fields<Q extends string, L1 extends string> = L1 extends unknown
    ? Record<L1, L2Combinations<L2Parts<Q, L1>>>
    : never

// build up all combinations of all L2 fields
type L2Combinations<L2 extends string> = [L2] extends [never]
    ? NotUndefined // short-circuit L1 queries (L2 is never)
    : Combine<L2Fields<L2>, L2>
// maps each L2 part of the filter query to an object and handles siblings
type L2Fields<L2 extends string> = L2 extends unknown
    ? Record<L2 | Twins<L2>, NotUndefined>
    : never

// define additional fields on U with value `undefined`
type Combine<U, K extends string> = U extends unknown
    ? U & Partial<Record<Exclude<K, keyof U>, undefined>>
    : never

// gets all L1 query snippets
type L1Parts<Q extends string> = Q extends `${infer U}:${string}` ? U : Q
// gets all L2 query snippets for the given L1 part, or `never`
type L2Parts<
    Q extends string,
    P extends string
> = Q extends `${P}:${infer U}:${string}`
    ? U
    : Q extends `${P}:${infer U}`
    ? U
    : never

/**
 * This type infers which properties will be present on the given context object
 * provided it matches a given filter query. If the filter query is a union
 * type, the produced context object will be a union of possible combinations,
 * hence allowing you to narrow down manually which of the properties are
 * present.
 *
 * In some sense, this type computes `matchFilter` on the type level.
 */
export type Filter<C extends Context, Q extends FilterQuery> = PerformQuery<
    C,
    RunQuery<ExpandShortcuts<Q>>
>
// apply a query result by intersecting it with Update, and then injecting into C
type PerformQuery<C extends Context, U extends SomeObject> = U extends unknown
    ? FilteredContext<C, Update & U>
    : never
// set the given update into a given context object, and adjust the aliases
type FilteredContext<C extends Context, U extends Update> = C &
    Record<'update', U> &
    AliasProps<Omit<U, 'update_id'>> &
    Shortcuts<U>

// helper type to infer shortcuts on context object based on present properties, must be in sync with shortcut impl!
interface Shortcuts<U extends Update> {
    msg: [U['callback_query']] extends [SomeObject]
        ? U['callback_query']['message']
        : [U['message']] extends [SomeObject]
        ? U['message']
        : [U['edited_message']] extends [SomeObject]
        ? U['edited_message']
        : [U['channel_post']] extends [SomeObject]
        ? U['channel_post']
        : [U['edited_channel_post']] extends [SomeObject]
        ? U['edited_channel_post']
        : undefined
    chat: [U['callback_query']] extends [SomeObject]
        ? NonNullable<U['callback_query']['message']>['chat'] | undefined
        : [Shortcuts<U>['msg']] extends [SomeObject]
        ? Shortcuts<U>['msg']['chat']
        : [U['my_chat_member']] extends [SomeObject]
        ? U['my_chat_member']['chat']
        : [U['chat_member']] extends [SomeObject]
        ? U['chat_member']['chat']
        : undefined
    // senderChat: disregarded here because always optional on 'Message'
    from: [U['callback_query']] extends [SomeObject]
        ? U['callback_query']['from']
        : [U['inline_query']] extends [SomeObject]
        ? U['inline_query']['from']
        : [U['shipping_query']] extends [SomeObject]
        ? U['shipping_query']['from']
        : [U['pre_checkout_query']] extends [SomeObject]
        ? U['pre_checkout_query']['from']
        : [U['chosen_inline_result']] extends [SomeObject]
        ? U['chosen_inline_result']['from']
        : [U['message']] extends [SomeObject]
        ? NonNullable<U['message']['from']>
        : [U['edited_message']] extends [SomeObject]
        ? NonNullable<U['edited_message']['from']>
        : [U['my_chat_member']] extends [SomeObject]
        ? U['my_chat_member']['from']
        : [U['chat_member']] extends [SomeObject]
        ? U['chat_member']['from']
        : undefined
    // inlineMessageId: disregarded here because always optional on both types
}

// === Define some helpers for handling shortcuts, e.g. in 'edit:photo'
const L1_SHORTCUTS = {
    '': ['message', 'channel_post'],
    msg: ['message', 'channel_post'],
    edit: ['edited_message', 'edited_channel_post'],
} as const
const L2_SHORTCUTS = {
    '': ['entities', 'caption_entities'],
    media: ['photo', 'video'],
    file: [
        'photo',
        'animation',
        'audio',
        'document',
        'video',
        'video_note',
        'voice',
        'sticker',
    ],
} as const
type L1Shortcuts = KeyOf<typeof L1_SHORTCUTS>
type L2Shortcuts = KeyOf<typeof L2_SHORTCUTS>

type ExpandShortcuts<Q extends string> =
    Q extends `${infer R}:${infer S}:${infer T}`
        ? `${ExpandL1<R>}:${ExpandL2<S>}:${T}`
        : Q extends `${infer R}:${infer S}`
        ? `${ExpandL1<R>}:${ExpandL2<S>}`
        : ExpandL1<Q>
type ExpandL1<S extends string> = S extends L1Shortcuts
    ? typeof L1_SHORTCUTS[S][number]
    : S
type ExpandL2<S extends string> = S extends L2Shortcuts
    ? typeof L2_SHORTCUTS[S][number]
    : S

// === Define some helpers for when one property implies the existence of others
type Twins<V extends string> = V extends KeyOf<Equivalents> ? Equivalents[V] : V
type Equivalents = {
    animation: 'document'
    entities: TextMessages
    caption: CaptionMessages
    caption_entities: CaptionMessages
}
type TextMessages = 'text'
type CaptionMessages =
    | 'animation'
    | 'audio'
    | 'document'
    | 'photo'
    | 'video'
    | 'voice'
