export const JobType = {
  SEND_OUTREACH:             'send-outreach',
  SEND_FOLLOWUP:             'send-followup',
  DEADLINE_CHECK:            'deadline-check',
  WAITLIST_CHECK:            'waitlist-check',
  WAITLIST_REMINDER:         'waitlist-reminder',
  AUTO_PICKUP:               'auto-pickup',
  BOOKING_APPROVAL_TIMEOUT:  'booking-approval-timeout',
} as const;

export type JobTypeName = typeof JobType[keyof typeof JobType];

// Job data shapes — populated with business logic in later phases
export interface SendOutreachData    { appointmentId: string }
export interface SendFollowupData    { conversationId: string; followupCount: number }
export interface DeadlineCheckData   { conversationId: string; appointmentId: string }
export interface WaitlistCheckData   { slotId: string; businessId: string }
export interface WaitlistReminderData {
  conversationId: string;
  slotId: string;
  businessId: string;
  final: boolean;
}
export interface AutoPickupData      {}
export interface BookingApprovalTimeoutData { conversationId: string }

// Deterministic job ID helpers — enables cancellation by conversation
export const jobId = {
  followup:              (conversationId: string, n: number) => `followup_${conversationId}_${n}`,
  deadlineCheck:         (conversationId: string)            => `deadline-check_${conversationId}`,
  waitlistReminder:      (conversationId: string)            => `waitlist-reminder_${conversationId}`,
  waitlistTimeout:       (conversationId: string)            => `waitlist-timeout_${conversationId}`,
  bookingApprovalTimeout:(conversationId: string)            => `booking-approval-timeout_${conversationId}`,
};
