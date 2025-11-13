import { z } from 'zod';
export declare const CandidateEventSchema: z.ZodObject<{
    address: z.ZodString;
    source: z.ZodEnum<["seed", "backfill", "daily"]>;
    ts: z.ZodString;
    tags: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    nickname: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNull]>>;
    score_hint: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
    meta: z.ZodDefault<z.ZodOptional<z.ZodObject<{}, "strip", z.ZodAny, z.objectOutputType<{}, z.ZodAny, "strip">, z.objectInputType<{}, z.ZodAny, "strip">>>>;
    notes: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNull]>>;
}, "strict", z.ZodTypeAny, {
    address: string;
    source: "seed" | "backfill" | "daily";
    ts: string;
    tags: string[];
    meta: {} & {
        [k: string]: any;
    };
    nickname?: string | null | undefined;
    score_hint?: number | null | undefined;
    notes?: string | null | undefined;
}, {
    address: string;
    source: "seed" | "backfill" | "daily";
    ts: string;
    tags?: string[] | undefined;
    nickname?: string | null | undefined;
    score_hint?: number | null | undefined;
    meta?: z.objectInputType<{}, z.ZodAny, "strip"> | undefined;
    notes?: string | null | undefined;
}>;
export type CandidateEvent = z.infer<typeof CandidateEventSchema>;
export declare const ScoreEventSchema: z.ZodObject<{
    address: z.ZodString;
    score: z.ZodNumber;
    weight: z.ZodNumber;
    rank: z.ZodNumber;
    window_s: z.ZodNumber;
    ts: z.ZodString;
    meta: z.ZodDefault<z.ZodOptional<z.ZodObject<{}, "strip", z.ZodAny, z.objectOutputType<{}, z.ZodAny, "strip">, z.objectInputType<{}, z.ZodAny, "strip">>>>;
}, "strict", z.ZodTypeAny, {
    address: string;
    ts: string;
    meta: {} & {
        [k: string]: any;
    };
    score: number;
    weight: number;
    rank: number;
    window_s: number;
}, {
    address: string;
    ts: string;
    score: number;
    weight: number;
    rank: number;
    window_s: number;
    meta?: z.objectInputType<{}, z.ZodAny, "strip"> | undefined;
}>;
export type ScoreEvent = z.infer<typeof ScoreEventSchema>;
export declare const FillEventSchema: z.ZodObject<{
    fill_id: z.ZodString;
    source: z.ZodEnum<["fake", "hyperliquid"]>;
    address: z.ZodString;
    asset: z.ZodString;
    side: z.ZodEnum<["buy", "sell"]>;
    size: z.ZodNumber;
    price: z.ZodNumber;
    start_position: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
    realized_pnl: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
    ts: z.ZodString;
    meta: z.ZodDefault<z.ZodOptional<z.ZodObject<{}, "strip", z.ZodAny, z.objectOutputType<{}, z.ZodAny, "strip">, z.objectInputType<{}, z.ZodAny, "strip">>>>;
}, "strict", z.ZodTypeAny, {
    address: string;
    source: "fake" | "hyperliquid";
    ts: string;
    meta: {} & {
        [k: string]: any;
    };
    fill_id: string;
    asset: string;
    side: "buy" | "sell";
    size: number;
    price: number;
    start_position?: number | null | undefined;
    realized_pnl?: number | null | undefined;
}, {
    address: string;
    source: "fake" | "hyperliquid";
    ts: string;
    fill_id: string;
    asset: string;
    side: "buy" | "sell";
    size: number;
    price: number;
    meta?: z.objectInputType<{}, z.ZodAny, "strip"> | undefined;
    start_position?: number | null | undefined;
    realized_pnl?: number | null | undefined;
}>;
export type FillEvent = z.infer<typeof FillEventSchema>;
export declare const OutcomeEventSchema: z.ZodObject<{
    ticket_id: z.ZodString;
    closed_ts: z.ZodString;
    result_r: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
    closed_reason: z.ZodEnum<["timebox", "manual", "error"]>;
    notes: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNull]>>;
}, "strict", z.ZodTypeAny, {
    ticket_id: string;
    closed_ts: string;
    closed_reason: "timebox" | "manual" | "error";
    notes?: string | null | undefined;
    result_r?: number | null | undefined;
}, {
    ticket_id: string;
    closed_ts: string;
    closed_reason: "timebox" | "manual" | "error";
    notes?: string | null | undefined;
    result_r?: number | null | undefined;
}>;
export type OutcomeEvent = z.infer<typeof OutcomeEventSchema>;
export declare const SignalEventSchema: z.ZodObject<{
    ticket_id: z.ZodString;
    address: z.ZodString;
    asset: z.ZodString;
    side: z.ZodEnum<["long", "short", "flat"]>;
    confidence: z.ZodNumber;
    score_ts: z.ZodString;
    signal_ts: z.ZodString;
    expires_at: z.ZodString;
    reason: z.ZodEnum<["consensus", "fallback"]>;
    payload: z.ZodDefault<z.ZodObject<{}, "strip", z.ZodAny, z.objectOutputType<{}, z.ZodAny, "strip">, z.objectInputType<{}, z.ZodAny, "strip">>>;
}, "strict", z.ZodTypeAny, {
    address: string;
    asset: string;
    side: "flat" | "long" | "short";
    ticket_id: string;
    confidence: number;
    score_ts: string;
    signal_ts: string;
    expires_at: string;
    reason: "consensus" | "fallback";
    payload: {} & {
        [k: string]: any;
    };
}, {
    address: string;
    asset: string;
    side: "flat" | "long" | "short";
    ticket_id: string;
    confidence: number;
    score_ts: string;
    signal_ts: string;
    expires_at: string;
    reason: "consensus" | "fallback";
    payload?: z.objectInputType<{}, z.ZodAny, "strip"> | undefined;
}>;
export type SignalEvent = z.infer<typeof SignalEventSchema>;
export declare const MessageSchemas: {
    readonly "a.candidates.v1": z.ZodObject<{
        address: z.ZodString;
        source: z.ZodEnum<["seed", "backfill", "daily"]>;
        ts: z.ZodString;
        tags: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
        nickname: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNull]>>;
        score_hint: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
        meta: z.ZodDefault<z.ZodOptional<z.ZodObject<{}, "strip", z.ZodAny, z.objectOutputType<{}, z.ZodAny, "strip">, z.objectInputType<{}, z.ZodAny, "strip">>>>;
        notes: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNull]>>;
    }, "strict", z.ZodTypeAny, {
        address: string;
        source: "seed" | "backfill" | "daily";
        ts: string;
        tags: string[];
        meta: {} & {
            [k: string]: any;
        };
        nickname?: string | null | undefined;
        score_hint?: number | null | undefined;
        notes?: string | null | undefined;
    }, {
        address: string;
        source: "seed" | "backfill" | "daily";
        ts: string;
        tags?: string[] | undefined;
        nickname?: string | null | undefined;
        score_hint?: number | null | undefined;
        meta?: z.objectInputType<{}, z.ZodAny, "strip"> | undefined;
        notes?: string | null | undefined;
    }>;
    readonly "b.scores.v1": z.ZodObject<{
        address: z.ZodString;
        score: z.ZodNumber;
        weight: z.ZodNumber;
        rank: z.ZodNumber;
        window_s: z.ZodNumber;
        ts: z.ZodString;
        meta: z.ZodDefault<z.ZodOptional<z.ZodObject<{}, "strip", z.ZodAny, z.objectOutputType<{}, z.ZodAny, "strip">, z.objectInputType<{}, z.ZodAny, "strip">>>>;
    }, "strict", z.ZodTypeAny, {
        address: string;
        ts: string;
        meta: {} & {
            [k: string]: any;
        };
        score: number;
        weight: number;
        rank: number;
        window_s: number;
    }, {
        address: string;
        ts: string;
        score: number;
        weight: number;
        rank: number;
        window_s: number;
        meta?: z.objectInputType<{}, z.ZodAny, "strip"> | undefined;
    }>;
    readonly "c.fills.v1": z.ZodObject<{
        fill_id: z.ZodString;
        source: z.ZodEnum<["fake", "hyperliquid"]>;
        address: z.ZodString;
        asset: z.ZodString;
        side: z.ZodEnum<["buy", "sell"]>;
        size: z.ZodNumber;
        price: z.ZodNumber;
        start_position: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
        realized_pnl: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
        ts: z.ZodString;
        meta: z.ZodDefault<z.ZodOptional<z.ZodObject<{}, "strip", z.ZodAny, z.objectOutputType<{}, z.ZodAny, "strip">, z.objectInputType<{}, z.ZodAny, "strip">>>>;
    }, "strict", z.ZodTypeAny, {
        address: string;
        source: "fake" | "hyperliquid";
        ts: string;
        meta: {} & {
            [k: string]: any;
        };
        fill_id: string;
        asset: string;
        side: "buy" | "sell";
        size: number;
        price: number;
        start_position?: number | null | undefined;
        realized_pnl?: number | null | undefined;
    }, {
        address: string;
        source: "fake" | "hyperliquid";
        ts: string;
        fill_id: string;
        asset: string;
        side: "buy" | "sell";
        size: number;
        price: number;
        meta?: z.objectInputType<{}, z.ZodAny, "strip"> | undefined;
        start_position?: number | null | undefined;
        realized_pnl?: number | null | undefined;
    }>;
    readonly "d.outcomes.v1": z.ZodObject<{
        ticket_id: z.ZodString;
        closed_ts: z.ZodString;
        result_r: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodNull]>>;
        closed_reason: z.ZodEnum<["timebox", "manual", "error"]>;
        notes: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNull]>>;
    }, "strict", z.ZodTypeAny, {
        ticket_id: string;
        closed_ts: string;
        closed_reason: "timebox" | "manual" | "error";
        notes?: string | null | undefined;
        result_r?: number | null | undefined;
    }, {
        ticket_id: string;
        closed_ts: string;
        closed_reason: "timebox" | "manual" | "error";
        notes?: string | null | undefined;
        result_r?: number | null | undefined;
    }>;
    readonly "d.signals.v1": z.ZodObject<{
        ticket_id: z.ZodString;
        address: z.ZodString;
        asset: z.ZodString;
        side: z.ZodEnum<["long", "short", "flat"]>;
        confidence: z.ZodNumber;
        score_ts: z.ZodString;
        signal_ts: z.ZodString;
        expires_at: z.ZodString;
        reason: z.ZodEnum<["consensus", "fallback"]>;
        payload: z.ZodDefault<z.ZodObject<{}, "strip", z.ZodAny, z.objectOutputType<{}, z.ZodAny, "strip">, z.objectInputType<{}, z.ZodAny, "strip">>>;
    }, "strict", z.ZodTypeAny, {
        address: string;
        asset: string;
        side: "flat" | "long" | "short";
        ticket_id: string;
        confidence: number;
        score_ts: string;
        signal_ts: string;
        expires_at: string;
        reason: "consensus" | "fallback";
        payload: {} & {
            [k: string]: any;
        };
    }, {
        address: string;
        asset: string;
        side: "flat" | "long" | "short";
        ticket_id: string;
        confidence: number;
        score_ts: string;
        signal_ts: string;
        expires_at: string;
        reason: "consensus" | "fallback";
        payload?: z.objectInputType<{}, z.ZodAny, "strip"> | undefined;
    }>;
};
