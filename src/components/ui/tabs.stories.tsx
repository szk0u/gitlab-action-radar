import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card, CardContent } from './card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const meta = {
  title: 'UI/Tabs',
  component: Tabs,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Tabs>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: () => (
    <Tabs defaultValue="assigned">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="assigned">Assigned (4)</TabsTrigger>
        <TabsTrigger value="review">Review requested (2)</TabsTrigger>
      </TabsList>
      <TabsContent value="assigned">
        <Card>
          <CardContent className="pt-5 text-sm text-slate-600">
            Assigned merge requests appear here.
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="review">
        <Card>
          <CardContent className="pt-5 text-sm text-slate-600">
            Review queue appears here.
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  ),
};
