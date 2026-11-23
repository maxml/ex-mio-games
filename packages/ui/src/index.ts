'use client';

// The barrel is a client boundary: many components hold state, and a server component that imports
// the barrel gets client references instead of tripping over hooks in a server module.
//
// Public API of @ex-mio/ui. The frontend is built only from these components;
// each one has a Storybook story (a test compares the two lists), and a new UI
// element starts as a story.
export { cn } from './cn';

// Foundations: theme runtime. Token values live in tokens.css and theme/tenants/*.json.
export {
  THEMES,
  MIO_DEFAULT,
  ThemeProvider,
  themeStyle,
  useTheme,
  type TenantTheme,
} from './theme/theme';

// Primitives
export { Button, type ButtonProps } from './Button';
export { Card, type CardProps } from './Card';
export { Input, Select, Field, type InputProps, type SelectProps } from './Input';
export { Checkbox, type CheckboxProps } from './Checkbox';
export {
  Heading,
  Text,
  Link,
  type HeadingProps,
  type TextProps,
  type TextTone,
} from './Typography';
export { Badge, StatusPill, type Status, type Tone } from './StatusPill';
export { Alert, Toast, type AlertTone } from './Toast';
export { Tabs, TabPanel, type TabItem } from './Tabs';
export { Table, type Column } from './Table';
export { Stepper, type Step } from './Stepper';
export { StepNav, type StepNavProps } from './StepNav';
export { Stack, Grid, Form, type StackProps, type GridProps, type FormProps } from './Layout';
export { Main, ThemeScope, LiveRegion, SignedAmount, type MainProps } from './Landmarks';
export { CellText } from './CellText';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { PreviewNotice, AccessNotice, type AccessNoticeProps } from './Notices';

// Composites
export { Wheel, type WheelSegment, type WheelSpin } from './Wheel';
export { CoinBalance, CoinIcon } from './CoinBalance';
export { StoreItemCard, type StoreItem } from './StoreItemCard';
export { StatTile } from './StatTile';
export { PlanCard } from './PlanCard';
export { KeyRow, KeyList } from './KeyRow';
export { BarChart, FunnelChart, type FunnelStep } from './Charts';
export { ActivityList, type ActivityItem } from './ActivityList';
export { RuleEditor, type RuleValues } from './RuleEditor';
export { WeightTable, type WeightRow } from './WeightTable';
export { EventLog, type EventLogEntry } from './EventLog';
export { CardForm } from './CardForm';
export {
  RoleNav,
  RoleSwitcher,
  NAV_GROUPS,
  ROLE_LABEL,
  type ConsoleRole,
  type PageAccess,
  type NavPage,
  type RoleNavProps,
  type RoleSwitcherProps,
} from './RoleNav';
export { SetupChecklist, type SetupChecklistProps } from './SetupChecklist';
export { PlanPicker, type PlanOption, type PlanPickerProps } from './PlanPicker';
export { FilterBar, type FilterOption, type FilterBarProps } from './FilterBar';
export {
  ResolvePanel,
  REASON_MIN,
  REASON_MAX,
  type ResolvePanelProps,
  type ResolveReviewPayload,
} from './ResolvePanel';
export {
  StoreItemForm,
  PriceField,
  priceError,
  type StoreItemFormProps,
  type StoreItemValues,
  type PriceFieldProps,
} from './StoreItemForm';
export { InviteStaffForm, type InviteStaffFormProps } from './InviteStaffForm';
export { InvoiceTable, type InvoiceRow, type InvoiceTableProps } from './InvoiceTable';
export { SpinPanel, type SpinPanelProps } from './SpinPanel';
export { RedeemFlow, type RedeemFlowProps, type RedeemStatus } from './RedeemFlow';
export {
  SignupPanel,
  PlanPanel,
  KeysPanel,
  RewardApiPanel,
  SandboxPanel,
  GoLivePanel,
  rewardApiError,
  type KeyEntry,
  type SignupPanelProps,
  type PlanPanelProps,
  type KeysPanelProps,
  type RewardApiPanelProps,
  type SandboxPanelProps,
  type GoLivePanelProps,
} from './SetupPanels';
export { ruleError, rulesValid } from './RuleEditor';

// Page templates
export { Page, SkipLink, SiteHeader, ThemeSwitcher, type NavItem } from './Page';
export {
  OperatorShell,
  StateBody,
  ReadOnlyNotice,
  type OperatorShellProps,
  type ShellProps,
  type PageState,
  type Environment,
  type TemplateBase,
} from './templates/OperatorShell';
export { SetupTemplate, type SetupTemplateProps } from './templates/SetupTemplate';
export {
  RulesTemplate,
  WheelTemplate,
  StoreTemplate,
  type RulesTemplateProps,
  type WheelTemplateProps,
  type WheelVersion,
  type StoreTemplateProps,
  type StoreAdminItem,
} from './templates/Engagement';
export {
  RedemptionsTemplate,
  type RedemptionsTemplateProps,
  type RedemptionRow,
  type RedemptionFilter,
} from './templates/Operations';
export {
  InsightsTemplate,
  TeamTemplate,
  type InsightsTemplateProps,
  type UsageStat,
  type TeamTemplateProps,
  type StaffMember,
} from './templates/InsightsTeam';
export {
  PlayerWidgetTemplate,
  AdminConsoleTemplate,
  type PlayerWidgetTemplateProps,
  type AdminConsoleTemplateProps,
  type TenantRow,
} from './templates/PlayerAdmin';
