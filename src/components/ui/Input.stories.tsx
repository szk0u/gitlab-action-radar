import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input } from './input';

const meta = {
  title: 'UI/Input',
  component: Input,
  tags: ['autodocs'],
  args: {
    placeholder: 'glpat-xxxxxxxxxxxxxxxxxxxx'
  },
  decorators: [
    (Story) => (
      <div className="w-[320px]">
        <Story />
      </div>
    )
  ],
  argTypes: {
    className: {
      control: false
    }
  }
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Disabled: Story = {
  args: {
    disabled: true,
    defaultValue: 'Stored securely'
  }
};
