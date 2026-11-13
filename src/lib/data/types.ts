/** 資料模型（對應規格第 8 節與 supabase/migrations）。資料表欄位對應見 src/lib/data/repo.ts。 */
import type { AppointmentStatus, ConflictStatus } from "@/lib/domain/rules";
import type { ConflictReason } from "@/lib/domain/conflicts";
import type { BlockRule, DoctorShift, OpeningRule } from "@/lib/domain/schedule";

export type Role = "sales" | "admin" | "deputy";

export interface UserAccount {
  id: string;
  loginName: string;
  passwordHash: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export interface Salesperson {
  id: string;
  displayName: string;
  active: boolean;
  sortOrder: number;
  userAccountId: string | null;
}

export interface Item {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
}

export interface Doctor {
  id: string;
  displayName: string;
  active: boolean;
}

export type DoctorShiftRow = DoctorShift & { id: string };
export type BlockRow = BlockRule & { id: string; reason: string };
export type OpeningRow = OpeningRule & { id: string };

export interface Appointment {
  id: string;
  code: string;
  customerName: string;
  phone: string;
  phoneNormalized: string;
  date: string;
  start: string;
  end: string;
  itemId: string;
  partySize: number;
  requiresDoctor: boolean;
  assignedDoctorId: string | null;
  preferredDoctorNote: string;
  careNote: string;
  salespersonId: string;
  status: AppointmentStatus;
  isOverbooked: boolean;
  overbookReason: string;
  conflictStatus: ConflictStatus;
  conflictReasons: ConflictReason[];
  conflictKeptReasons: ConflictReason[];
  conflictKeptNote: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  version: number;
}

export type NotifyEvent = "sales_cancel" | "sales_edit_within_4h" | "deputy_action" | "duplicate_phone" | "sales_edit";
export type NotifyMode = "instant" | "digest" | "none";

export interface Notification {
  id: string;
  event: NotifyEvent;
  appointmentId: string | null;
  actorUserId: string;
  summary: string;
  mode: NotifyMode;
  readAt: string | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  entityType: "appointment" | "schedule" | "settings" | "account" | "item" | "doctor" | "salesperson";
  entityId: string;
  actorUserId: string;
  action: string;
  changes: Record<string, unknown>;
  reason: string;
  createdAt: string;
}

export interface Settings {
  maxDays: number;
  notifyEmails: string[];
  notifyModes: Record<NotifyEvent, NotifyMode>;
}
