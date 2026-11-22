import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { Button } from './Button';
import { CellText } from './CellText';
import { EmptyState } from './EmptyState';
import { AccessNotice, PreviewNotice } from './Notices';
import { Alert } from './Toast';

const meta = { title: 'Primitives/Notices', component: PreviewNotice } satisfies Meta<
  typeof PreviewNotice
>;

export default meta;
type Story = StoryObj;

export const Preview: Story = {
  render: () => <PreviewNotice />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(
      'Preview: not connected to a live service yet (W-14)',
    );
  },
};

export const Access: Story = {
  render: () => <AccessNotice role="Staff" page="Engagement › Rules" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(
      'Your role (Staff) cannot open Engagement › Rules. Ask an operator admin.',
    );
  },
};

/** The `live` prop makes an Alert a status or alert region. */
export const AlertLive: Story = {
  render: () => (
    <div className="grid gap-3">
      <Alert tone="info" live="status">
        Saved.
      </Alert>
      <Alert tone="danger" live="alert">
        Could not save.
      </Alert>
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <EmptyState title="No items yet." action={<Button>Add your first item</Button>}>
      Items you add here show up in the player store.
    </EmptyState>
  ),
};

export const TwoLineCell: Story = {
  render: () => <CellText primary="player-1001" secondary="2026-11-20 10:14" />,
};
