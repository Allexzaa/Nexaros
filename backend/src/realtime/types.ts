// JWT token payload — defined here so both WebSocket auth and future F002 auth share the same shape
export interface StaffTokenPayload {
  sub: string;        // staffUserId
  businessId: string;
  type: 'staff';
  role: 'admin' | 'staff' | 'viewer';
}

export interface ClientTokenPayload {
  sub: string;        // clientId
  businessId: string;
  type: 'client';
}

export type TokenPayload = StaffTokenPayload | ClientTokenPayload;

// WebSocket event envelope — all messages use { event, payload }
export type WsEventType =
  | 'new_message'
  | 'conversation_state_changed'
  | 'staff_alert'
  | 'appointment_confirmed'
  | 'booking_approval_requested'
  | 'ai_escalation'
  | 'booking_request_pending'
  | 'deadline_reached'
  | 'message_delivered'
  | 'takeover_started';

export interface WsEnvelope<T = unknown> {
  event: WsEventType;
  payload: T;
}

// Per-event payload shapes (mirrors F001 spec WebSocket Event Schema)
export interface MessageRecord {
  id: string;
  sender: 'ai' | 'client' | 'staff';
  content: string;
  timestamp: string;
}

export interface NewMessagePayload {
  conversation_id: string;
  message: MessageRecord;
}

export interface ConversationStateChangedPayload {
  conversation_id: string;
  state: string;
  client_name: string;
}

export interface StaffAlertPayload {
  alert_type: string;
  conversation_id: string;
  client_name: string;
  reason: string;
}

export interface AppointmentConfirmedPayload {
  appointment_id: string;
  client_name: string;
  time: string;
  service_type: string;
}

export interface BookingApprovalRequestedPayload {
  conversation_id: string;
  client_name: string;
  service_type: string;
  preferred_time: string;
}

export interface MessageDeliveredPayload {
  message_id: string;
}

export interface TakeoverStartedPayload {
  conversation_id: string;
}

export interface DeadlineReachedPayload {
  conversation_id: string;
  client_name: string;
}

export interface AiEscalationPayload {
  conversation_id: string;
  client_name: string;
  escalation_reason: string;
}

export interface BookingRequestPendingPayload {
  conversation_id: string;
  client_name: string;
}
