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

// Page templates
export { Page, SkipLink, SiteHeader, ThemeSwitcher, type NavItem } from './Page';
