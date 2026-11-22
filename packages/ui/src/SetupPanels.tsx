import { useState, type FormEvent } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { CardForm } from './CardForm';
import { EventLog, type EventLogEntry } from './EventLog';
import { Field, Input } from './Input';
import { KeyList, KeyRow } from './KeyRow';
import { PreviewNotice } from './Notices';
import { PlanPicker, type PlanOption } from './PlanPicker';
import { SetupChecklist } from './SetupChecklist';
import type { Step } from './Stepper';
import { Alert } from './Toast';

// The six panels of the Setup page (Get started). Each is a Card with one job.

export interface SignupPanelProps {
  onSubmit: (values: { company: string; email: string }) => void;
  busy?: boolean;
  /** Shown when the account already exists. */
  done?: boolean;
  error?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Create the operator account. */
export function SignupPanel({ onSubmit, busy, done, error }: SignupPanelProps) {
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [tried, setTried] = useState(false);
  const companyError = company.trim() ? undefined : 'Enter the company name.';
  const emailError = EMAIL.test(email.trim()) ? undefined : 'Enter a valid email address.';
  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (busy || companyError || emailError) return;
    onSubmit({ company: company.trim(), email: email.trim() });
  }
  if (done)
    return (
      <Card title="Account">
        <Alert tone="success" live="status">
          Account created.
        </Alert>
      </Card>
    );
  return (
    <Card title="Account" description="Create your operator account.">
      <form className="grid max-w-md gap-4" onSubmit={submit} noValidate>
        <Field label="Company" error={tried ? companyError : undefined}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              value={company}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => setCompany(e.target.value)}
            />
          )}
        </Field>
        <Field label="Work email" error={tried ? emailError : undefined}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              type="email"
              value={email}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        {error && (
          <Alert tone="danger" live="alert">
            {error}
          </Alert>
        )}
        <div>
          <Button type="submit" loading={busy}>
            Create account
          </Button>
        </div>
      </form>
    </Card>
  );
}

export interface PlanPanelProps {
  plans: PlanOption[];
  planId: string | null;
  onSelectPlan: (planId: string) => void;
  /** The plan is already paid for: the card form is replaced by a confirmation. */
  paid?: boolean;
  processing?: boolean;
  failure?: string;
  onPay: (last4: string) => void;
  onCancel?: () => void;
}

/** Choose a plan and pay with the test card. */
export function PlanPanel({
  plans,
  planId,
  onSelectPlan,
  paid,
  processing,
  failure,
  onPay,
  onCancel,
}: PlanPanelProps) {
  const plan = plans.find((p) => p.id === planId);
  return (
    <div className="grid gap-4">
      <Card title="Plan" description="Pick the plan that fits your players.">
        <PlanPicker plans={plans} value={planId} onChange={onSelectPlan} disabled={paid} />
      </Card>
      {paid ? (
        <Alert tone="success" live="status">
          Plan paid{plan ? `: ${plan.name}` : ''}.
        </Alert>
      ) : (
        plan && (
          <CardForm
            amount={plan.price}
            description={`${plan.name} plan, first month`}
            testMode
            processing={processing}
            failure={failure}
            onSubmit={onPay}
            onCancel={onCancel}
          />
        )
      )}
    </div>
  );
}

export interface KeyEntry {
  id: string;
  label: string;
  value: string;
  secret?: boolean;
}

export interface KeysPanelProps {
  keys: KeyEntry[];
  /** Label of the issue button, for example "Issue sandbox keys". Omit when nothing can be issued. */
  issueLabel?: string;
  onIssue?: () => void;
  busy?: boolean;
  onCopy?: (keyId: string) => void;
  /** The key list has no BFF route yet. */
  preview?: boolean;
}

/** Integration keys: publishable and secret, secrets masked until revealed. */
export function KeysPanel({ keys, issueLabel, onIssue, busy, onCopy, preview }: KeysPanelProps) {
  return (
    <Card title="Integration keys" description="Secrets are shown once. Copy them now.">
      <div className="grid gap-4">
        {preview && <PreviewNotice />}
        {keys.length === 0 ? (
          <p className="text-sm text-fg-muted">No keys issued yet.</p>
        ) : (
          <KeyList>
            {keys.map((k) => (
              <KeyRow
                key={k.id}
                label={k.label}
                value={k.value}
                secret={k.secret}
                onCopy={onCopy ? () => onCopy(k.id) : undefined}
              />
            ))}
          </KeyList>
        )}
        {issueLabel && onIssue && (
          <div>
            <Button loading={busy} onClick={onIssue}>
              {issueLabel}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export interface RewardApiPanelProps {
  onSubmit: (url: string) => void;
  /** Hosts that may use plain http (local development). */
  allowHttpHosts?: string[];
  /** The reward-API PUT has no BFF route yet: validates, does not send. */
  preview?: boolean;
}

/** The reward endpoint check (D-30): https, unless the host is on the local allow-list. */
export function rewardApiError(
  raw: string,
  allowHttpHosts: string[] = ['localhost', '127.0.0.1'],
): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return 'Enter a full URL, for example https://casino.example/reward.';
  }
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:' && allowHttpHosts.includes(u.hostname)) return undefined;
  return 'The reward endpoint must use https://. Plain http is allowed only for local hosts.';
}

/** Register the casino's reward endpoint. */
export function RewardApiPanel({ onSubmit, allowHttpHosts, preview = true }: RewardApiPanelProps) {
  const [url, setUrl] = useState('');
  const error = url.trim() ? rewardApiError(url, allowHttpHosts) : undefined;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim() || rewardApiError(url, allowHttpHosts)) return;
    onSubmit(url.trim());
  }
  return (
    <Card title="Reward API" description="Where we call your casino to credit a reward.">
      <form className="grid max-w-md gap-4" onSubmit={submit} noValidate>
        {preview && <PreviewNotice />}
        <Field label="Reward endpoint URL" error={error}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              type="url"
              value={url}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>
        <div>
          <Button type="submit" disabled={!url.trim() || Boolean(error)}>
            Save endpoint
          </Button>
        </div>
      </form>
    </Card>
  );
}

export interface SandboxPanelProps {
  entries: EventLogEntry[];
  running?: boolean;
  onRun: () => void;
  preview?: boolean;
}

/** Run the sandbox casino test and read its log. */
export function SandboxPanel({ entries, running, onRun, preview = true }: SandboxPanelProps) {
  return (
    <Card title="Sandbox test" description="Send a test deposit through the sandbox casino.">
      <div className="grid gap-4">
        {preview && <PreviewNotice />}
        <EventLog entries={entries} />
        <div>
          <Button loading={running} onClick={onRun}>
            Run sandbox test
          </Button>
        </div>
      </div>
    </Card>
  );
}

export interface GoLivePanelProps {
  steps: Step[];
  onSelectStep: (stepId: string) => void;
  liveKeys: KeyEntry[];
  /** `idle`: not started. `waiting`: live keys issued, waiting for the first live deposit. `live`. */
  phase: 'idle' | 'waiting' | 'live';
  onStart: () => void;
  onConfirmDeposit?: () => void;
  preview?: boolean;
}

/** Switch to live keys and wait for the first live deposit. Blocked while steps are missing. */
export function GoLivePanel({
  steps,
  onSelectStep,
  liveKeys,
  phase,
  onStart,
  onConfirmDeposit,
  preview = true,
}: GoLivePanelProps) {
  const prior = steps.filter((s) => s.id !== 'golive');
  const ready = prior.every((s) => s.done);
  return (
    <Card title="Go live" description="Switch to live keys and take the first live deposit.">
      <div className="grid gap-4">
        {preview && <PreviewNotice />}
        {!ready && phase === 'idle' && (
          <Alert tone="warning" live="status">
            <SetupChecklist variant="missing" steps={prior} current="" onSelect={onSelectStep} />
          </Alert>
        )}
        {phase !== 'idle' && (
          <KeyList>
            {liveKeys.map((k) => (
              <KeyRow key={k.id} label={k.label} value={k.value} secret={k.secret} />
            ))}
          </KeyList>
        )}
        {phase === 'waiting' && (
          <Alert tone="info" live="status">
            Waiting for the first live deposit.
          </Alert>
        )}
        {phase === 'live' && (
          <Alert tone="success" live="status">
            You are live.
          </Alert>
        )}
        {phase === 'idle' && (
          <div>
            <Button disabled={!ready} onClick={onStart}>
              Switch to live keys
            </Button>
          </div>
        )}
        {phase === 'waiting' && onConfirmDeposit && (
          <div>
            <Button onClick={onConfirmDeposit}>I received the first live deposit</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
