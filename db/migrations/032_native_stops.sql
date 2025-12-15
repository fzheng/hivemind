-- Native Stop Orders Support
-- Phase 6.2: Execution Resilience
--
-- Adds native_stop_placed flag to track whether stop orders are placed
-- directly on the exchange (lower latency) vs monitored locally (polling).

-- Add native_stop_placed column to active_stops
ALTER TABLE active_stops
    ADD COLUMN IF NOT EXISTS native_stop_placed BOOLEAN DEFAULT false;

-- Add native_stop_order_ids to track exchange order IDs for cancellation
ALTER TABLE active_stops
    ADD COLUMN IF NOT EXISTS native_sl_order_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS native_tp_order_id VARCHAR(64);

-- Update triggered_reason to include 'native_stop' as option
COMMENT ON COLUMN active_stops.triggered_reason IS 'Why stop was triggered: stop_loss, take_profit, timeout, manual, native_stop';

-- Comments
COMMENT ON COLUMN active_stops.native_stop_placed IS 'Whether SL/TP orders are placed on exchange vs polled locally';
COMMENT ON COLUMN active_stops.native_sl_order_id IS 'Exchange order ID for native stop-loss order';
COMMENT ON COLUMN active_stops.native_tp_order_id IS 'Exchange order ID for native take-profit order';
