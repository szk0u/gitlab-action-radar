import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { MergeRequestList } from './MergeRequestList';
import type { MergeRequestHealth } from '../types/gitlab';

function buildMergeRequestHealth(
  id: number,
  overrides: Partial<MergeRequestHealth> = {},
): MergeRequestHealth {
  return {
    mergeRequest: {
      id,
      iid: id,
      project_id: 101,
      title: `Improve reviewer workflow ${id}`,
      web_url: `https://gitlab.com/example/project/-/merge_requests/${id}`,
      state: 'opened',
      updated_at: '2026-03-27T08:30:00.000Z',
      assignee: { id: 1, username: 'kohei', name: 'Kohei' },
      assignees: [{ id: 1, username: 'kohei', name: 'Kohei' }],
      author: { id: 2, username: 'teammate', name: 'Teammate' },
      has_conflicts: false,
      merge_status: 'can_be_merged',
      references: {
        full: 'example/project!42',
      },
      pipeline: {
        status: 'success',
      },
      reviewers: [{ id: 1 }],
    },
    ciStatus: 'success',
    hasFailedCi: false,
    hasConflicts: false,
    hasPendingApprovals: false,
    isCreatedByMe: false,
    ...overrides,
  };
}

const assignedBase = buildMergeRequestHealth(42);

const assignedItems: MergeRequestHealth[] = [
  {
    ...assignedBase,
    hasConflicts: true,
    hasPendingApprovals: true,
    mergeRequest: {
      ...assignedBase.mergeRequest,
      title: 'Fix flaky webhook retries',
      updated_at: '2026-03-27T10:12:00.000Z',
    },
  },
  {
    ...buildMergeRequestHealth(43),
    ciStatus: 'failed',
    hasFailedCi: true,
    mergeRequest: {
      ...buildMergeRequestHealth(43).mergeRequest,
      title: 'Refactor alert persistence',
      updated_at: '2026-03-27T06:45:00.000Z',
    },
  },
  {
    ...buildMergeRequestHealth(44),
    isCreatedByMe: true,
    ownMrChecks: {
      isApproved: true,
      hasUnresolvedComments: false,
      ciStatus: 'success',
    },
    mergeRequest: {
      ...buildMergeRequestHealth(44).mergeRequest,
      title: 'Polish notification copy',
      updated_at: '2026-03-26T23:10:00.000Z',
    },
  },
];

const reviewRequestedItems: MergeRequestHealth[] = [
  {
    ...buildMergeRequestHealth(51),
    reviewerChecks: {
      reviewStatus: 'needs_review',
      reviewerLastCommentedAt: '2026-03-26T12:00:00.000Z',
      latestCommitAt: '2026-03-27T09:55:00.000Z',
      authorLastCommentedAt: '2026-03-27T10:00:00.000Z',
    },
    mergeRequest: {
      ...buildMergeRequestHealth(51).mergeRequest,
      title: 'Add command palette shortcuts',
      updated_at: '2026-03-27T09:55:00.000Z',
    },
  },
  {
    ...buildMergeRequestHealth(52),
    reviewerChecks: {
      reviewStatus: 'waiting_for_author',
      reviewerLastCommentedAt: '2026-03-25T08:10:00.000Z',
      latestCommitAt: '2026-03-25T07:50:00.000Z',
      authorLastCommentedAt: '2026-03-25T08:00:00.000Z',
    },
    mergeRequest: {
      ...buildMergeRequestHealth(52).mergeRequest,
      title: 'Improve PAT onboarding',
      updated_at: '2026-03-25T08:00:00.000Z',
    },
  },
];

const meta = {
  title: 'Composite/MergeRequestList',
  component: MergeRequestList,
  tags: ['autodocs'],
  args: {
    assignedItems,
    reviewRequestedItems,
    ignoredAssignedAlerts: [{ mergeRequestId: 43, ignoreConflicts: false, ignoreFailedCi: true }],
    onOpenMergeRequest: fn(),
    onIgnoreAssignedUntilNewCommit: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-4xl">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof MergeRequestList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    loading: true,
    assignedItems: [],
    reviewRequestedItems: [],
  },
};

export const ErrorState: Story = {
  args: {
    error: 'Failed to load merge requests from GitLab.',
    assignedItems: [],
    reviewRequestedItems: [],
  },
};

export const Empty: Story = {
  args: {
    assignedItems: [],
    reviewRequestedItems: [],
  },
};
