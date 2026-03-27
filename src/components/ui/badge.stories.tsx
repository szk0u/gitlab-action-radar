import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Badge } from './badge';

const meta = {
  title: 'UI/Badge',
  component: Badge,
  tags: ['autodocs'],
  args: {
    children: 'Status'
  },
  argTypes: {
    className: {
      control: false
    }
  }
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const StatusSet: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge>
        <CheckCircle2 />
        Healthy
      </Badge>
      <Badge variant="secondary">Pending approvals</Badge>
      <Badge variant="warning">
        <AlertCircle />
        Conflicts
      </Badge>
      <Badge variant="destructive">CI failed</Badge>
      <Badge variant="outline">Review requested</Badge>
    </div>
  )
};
