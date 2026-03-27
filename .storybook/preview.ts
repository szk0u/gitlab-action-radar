import type { Preview } from '@storybook/react-vite';
import '../src/styles.css';

const preview = {
  parameters: {
    layout: 'centered',
    backgrounds: {
      default: 'slate',
      values: [
        { name: 'slate', value: '#e2e8f0' },
        { name: 'white', value: '#ffffff' }
      ]
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    options: {
      storySort: {
        order: ['UI', 'Composite']
      }
    }
  }
} satisfies Preview;

export default preview;
