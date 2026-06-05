export interface MetaStatusError {
    code?: number | string;
    title?: string;
    message?: string;
}

export interface MetaStatusUpdate {
    id: string;
    status: string;
    timestamp?: string;
    recipient_id?: string;
    errors?: MetaStatusError[];
}

export interface MetaInboundMessage {
    id: string;
    from: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
}

export interface MetaWebhookChangeValue {
    messaging_product?: string;
    metadata?: { phone_number_id?: string; display_phone_number?: string };
    statuses?: MetaStatusUpdate[];
    messages?: MetaInboundMessage[];
    errors?: MetaStatusError[];
}

export interface MetaWebhookPayload {
    object?: string;
    entry?: Array<{
        id?: string;
        changes?: Array<{
            field?: string;
            value?: MetaWebhookChangeValue;
        }>;
    }>;
}

export interface FlatWidersWebhookPayload {
    event?: string;
    type?: string;
    message_id?: string;
    messageId?: string;
    wamid?: string;
    status?: string;
    phone?: string;
    timestamp?: string | number;
    error?: string;
    errors?: MetaStatusError[];
    data?: Record<string, unknown>;
}

export interface ParsedWebhookStatus {
    eventKey: string;
    messageId: string;
    status: string;
    phone?: string;
    timestamp?: Date;
    errors?: MetaStatusError[];
    raw: Record<string, unknown>;
}

export interface ParsedWebhookInbound {
    eventKey: string;
    messageId: string;
    phone: string;
    text?: string;
    timestamp?: Date;
    raw: Record<string, unknown>;
}
