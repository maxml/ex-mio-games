import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TabPanel, Tabs } from './Tabs';

const meta = { title: 'Primitives/Tabs', component: Tabs } satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj;

const TABS = [
  { id: 'wheel', label: 'Wheel' },
  { id: 'store', label: 'Bonus Store' },
  { id: 'history', label: 'History' },
] as const;

/** Arrows, Home and End move the selection and the focus together. */
export const Default: Story = {
  render: () => {
    const [value, setValue] = useState<(typeof TABS)[number]['id']>('wheel');
    return (
      <div>
        <Tabs
          tabs={[...TABS]}
          value={value}
          onChange={setValue}
          label="Widget sections"
          idPrefix="story"
          className="mb-4"
        />
        <TabPanel idPrefix="story" id={value}>
          Panel: {value}
        </TabPanel>
      </div>
    );
  },
};
