-- Migration: 011_ui_sessions_and_actions.sql
-- Description: Adds ui_sessions, ui_actions, and append-only ui_action_deliveries
-- for secure same-conversation local control center and leased outbox engine.

CREATE TABLE IF NOT EXISTS ui_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    session_cookie_hash VARCHAR(64) UNIQUE NULL,
    conversation_id VARCHAR(255) NOT NULL,
    workspace_path TEXT NOT NULL,
    purpose VARCHAR(100) NOT NULL,
    allowed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    redeemed_at TIMESTAMPTZ NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ui_sessions_token_hash ON ui_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_ui_sessions_cookie_hash ON ui_sessions(session_cookie_hash);
CREATE INDEX IF NOT EXISTS idx_ui_sessions_conversation ON ui_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ui_sessions_expires ON ui_sessions(expires_at);

CREATE TABLE IF NOT EXISTS ui_actions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ui_session_id UUID NOT NULL REFERENCES ui_sessions(id) ON DELETE RESTRICT,
    action_type VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'LEASED', 'DELIVERED', 'FAILED', 'DEAD_LETTER', 'SUPERSEDED')),
    lease_token VARCHAR(64) NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ NULL,
    processed_at TIMESTAMPTZ NULL,
    error_summary TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ui_action_session_idempotency UNIQUE (ui_session_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ui_actions_session ON ui_actions(ui_session_id);
CREATE INDEX IF NOT EXISTS idx_ui_actions_status ON ui_actions(status);
CREATE INDEX IF NOT EXISTS idx_ui_actions_next_retry ON ui_actions(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_ui_actions_idempotency ON ui_actions(idempotency_key);

CREATE TABLE IF NOT EXISTS ui_action_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ui_action_id UUID NOT NULL REFERENCES ui_actions(id) ON DELETE RESTRICT,
    attempt_number INT NOT NULL,
    status VARCHAR(50) NOT NULL,
    error_details TEXT NULL,
    duration_ms INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ui_action_attempt UNIQUE (ui_action_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_ui_action_deliveries_action ON ui_action_deliveries(ui_action_id);

-- Immutability triggers for audit preservation
CREATE OR REPLACE FUNCTION protect_ui_action_content() RETURNS trigger AS $$
BEGIN
    IF ROW(NEW.ui_session_id, NEW.action_type, NEW.entity_type, NEW.entity_id, NEW.payload, NEW.idempotency_key, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.ui_session_id, OLD.action_type, OLD.entity_type, OLD.entity_id, OLD.payload, OLD.idempotency_key, OLD.created_at) THEN
        RAISE EXCEPTION 'UI action definition and payload are immutable; cannot alter historical action fields';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_ui_action_content ON ui_actions;
CREATE TRIGGER trg_protect_ui_action_content BEFORE UPDATE ON ui_actions
    FOR EACH ROW EXECUTE FUNCTION protect_ui_action_content();

CREATE OR REPLACE FUNCTION protect_ui_action_deliveries() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'UI action deliveries are strictly append-only audit records';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_ui_action_deliveries_update ON ui_action_deliveries;
CREATE TRIGGER trg_protect_ui_action_deliveries_update BEFORE UPDATE OR DELETE ON ui_action_deliveries
    FOR EACH ROW EXECUTE FUNCTION protect_ui_action_deliveries();
