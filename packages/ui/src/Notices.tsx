import { Alert } from './Toast';

/** Marks an element whose data or action is not connected to a live service yet (W-14). */
export function PreviewNotice({ children }: { children?: string }) {
  return (
    <Alert tone="info" live="status">
      {children ?? 'Preview: not connected to a live service yet (W-14).'}
    </Alert>
  );
}

export interface AccessNoticeProps {
  /** The console role's UI name, for example "Staff". */
  role: string;
  /** The page's group and label, for example "Engagement › Rules". */
  page: string;
}

/** Shown on the landing page after a guard redirect, or inline when the server refuses a request. */
export function AccessNotice({ role, page }: AccessNoticeProps) {
  return (
    <Alert tone="warning" live="alert">
      Your role ({role}) cannot open {page}. Ask an operator admin.
    </Alert>
  );
}
