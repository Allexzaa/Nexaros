import { registry } from './registry';
import {
  WsEventType,
  WsEnvelope,
  MessageRecord,
  NewMessagePayload,
  ConversationStateChangedPayload,
  StaffAlertPayload,
  AppointmentConfirmedPayload,
  BookingApprovalRequestedPayload,
  AiEscalationPayload,
  BookingRequestPendingPayload,
  DeadlineReachedPayload,
  MessageDeliveredPayload,
  TakeoverStartedPayload,
} from './types';

function toStaff<T>(businessId: string, event: WsEventType, payload: T): void {
  registry.sendToStaff(businessId, JSON.stringify({ event, payload } satisfies WsEnvelope<T>));
}

function toClient<T>(clientId: string, event: WsEventType, payload: T): void {
  registry.sendToClient(clientId, JSON.stringify({ event, payload } satisfies WsEnvelope<T>));
}

// Both channels receive new messages
export function emitNewMessage(
  businessId: string,
  clientId: string,
  conversationId: string,
  message: MessageRecord,
): void {
  const payload: NewMessagePayload = { conversation_id: conversationId, message };
  toStaff(businessId, 'new_message', payload);
  toClient(clientId, 'new_message', payload);
}

// Staff-only
export function emitConversationStateChanged(
  businessId: string,
  conversationId: string,
  state: string,
  clientName: string,
): void {
  toStaff<ConversationStateChangedPayload>(businessId, 'conversation_state_changed', {
    conversation_id: conversationId,
    state,
    client_name: clientName,
  });
}

export function emitStaffAlert(
  businessId: string,
  alertType: string,
  conversationId: string,
  clientName: string,
  reason: string,
): void {
  toStaff<StaffAlertPayload>(businessId, 'staff_alert', {
    alert_type: alertType,
    conversation_id: conversationId,
    client_name: clientName,
    reason,
  });
}

export function emitAppointmentConfirmed(
  businessId: string,
  appointmentId: string,
  clientName: string,
  time: string,
  serviceType: string,
): void {
  toStaff<AppointmentConfirmedPayload>(businessId, 'appointment_confirmed', {
    appointment_id: appointmentId,
    client_name: clientName,
    time,
    service_type: serviceType,
  });
}

export function emitBookingApprovalRequested(
  businessId: string,
  conversationId: string,
  clientName: string,
  serviceType: string,
  preferredTime: string,
): void {
  toStaff<BookingApprovalRequestedPayload>(businessId, 'booking_approval_requested', {
    conversation_id: conversationId,
    client_name: clientName,
    service_type: serviceType,
    preferred_time: preferredTime,
  });
}

export function emitEscalation(
  businessId: string,
  conversationId: string,
  clientName: string,
  escalationReason: string,
): void {
  toStaff<AiEscalationPayload>(businessId, 'ai_escalation', {
    conversation_id: conversationId,
    client_name: clientName,
    escalation_reason: escalationReason,
  });
}

export function emitBookingRequestPending(
  businessId: string,
  conversationId: string,
  clientName: string,
): void {
  toStaff<BookingRequestPendingPayload>(businessId, 'booking_request_pending', {
    conversation_id: conversationId,
    client_name: clientName,
  });
}

export function emitDeadlineReached(businessId: string, conversationId: string, clientName: string): void {
  toStaff<DeadlineReachedPayload>(businessId, 'deadline_reached', {
    conversation_id: conversationId,
    client_name: clientName,
  });
}

// Client-only
export function emitMessageDelivered(clientId: string, messageId: string): void {
  toClient<MessageDeliveredPayload>(clientId, 'message_delivered', { message_id: messageId });
}

export function emitTakeoverStarted(clientId: string, conversationId: string): void {
  toClient<TakeoverStartedPayload>(clientId, 'takeover_started', { conversation_id: conversationId });
}
