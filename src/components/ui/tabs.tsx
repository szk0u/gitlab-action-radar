import * as React from 'preact/compat';
import { useId, useState } from 'preact/hooks';
import { cn } from '../../lib/utils';

interface TabsContextValue {
  baseId: string;
  value: string;
  setValue: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | undefined>(undefined);

function useTabsContext(componentName: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error(`${componentName} must be used within Tabs`);
  }
  return context;
}

function getTabId(baseId: string, value: string): string {
  return `${baseId}-tab-${value}`;
}

function getPanelId(baseId: string, value: string): string {
  return `${baseId}-panel-${value}`;
}

type TabsProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> & {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
};

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ className, defaultValue, value, onValueChange, ...props }, ref) => {
    const generatedId = useId();
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? '');
    const activeValue = value ?? uncontrolledValue;

    function setValue(nextValue: string): void {
      if (value === undefined) {
        setUncontrolledValue(nextValue);
      }
      onValueChange?.(nextValue);
    }

    return (
      <TabsContext.Provider value={{ baseId: generatedId, value: activeValue, setValue }}>
        <div ref={ref} className={className} {...props} />
      </TabsContext.Provider>
    );
  },
);
Tabs.displayName = 'Tabs';

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      role="tablist"
      ref={ref}
      className={cn(
        'inline-flex h-9 items-center rounded-lg bg-slate-200 p-1 text-slate-600',
        className,
      )}
      {...props}
    />
  ),
);
TabsList.displayName = 'TabsList';

type TabsTriggerProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> & {
  value: string;
};

const tabKeyMap = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
} as const;

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, disabled, onClick, onKeyDown, ...props }, ref) => {
    const context = useTabsContext('TabsTrigger');
    const isActive = context.value === value;

    function focusTab(offset: number, currentTarget: HTMLButtonElement): void {
      const tabList = currentTarget.closest('[role="tablist"]');
      const tabs = Array.from(
        tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [],
      );
      const currentIndex = tabs.indexOf(currentTarget);
      if (currentIndex === -1 || tabs.length === 0) {
        return;
      }

      const nextIndex =
        offset === Number.NEGATIVE_INFINITY
          ? 0
          : offset === Number.POSITIVE_INFINITY
            ? tabs.length - 1
            : (currentIndex + offset + tabs.length) % tabs.length;
      const nextTab = tabs[nextIndex];
      nextTab?.focus();
      nextTab?.click();
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
      onKeyDown?.(event);
      if (event.defaultPrevented) {
        return;
      }

      if (event.key in tabKeyMap) {
        event.preventDefault();
        focusTab(tabKeyMap[event.key as keyof typeof tabKeyMap], event.currentTarget);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusTab(Number.NEGATIVE_INFINITY, event.currentTarget);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusTab(Number.POSITIVE_INFINITY, event.currentTarget);
      }
    }

    function handleClick(event: React.MouseEvent<HTMLButtonElement>): void {
      onClick?.(event);
      if (!event.defaultPrevented) {
        context.setValue(value);
      }
    }

    return (
      <button
        type="button"
        role="tab"
        id={getTabId(context.baseId, value)}
        aria-controls={getPanelId(context.baseId, value)}
        aria-selected={isActive}
        data-state={isActive ? 'active' : 'inactive'}
        disabled={disabled}
        tabIndex={isActive ? 0 : -1}
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-white data-[state=active]:text-slate-900 data-[state=active]:shadow-sm',
          className,
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

type TabsContentProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'value'> & {
  value: string;
};

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const context = useTabsContext('TabsContent');
    const isActive = context.value === value;

    return (
      <div
        role="tabpanel"
        id={getPanelId(context.baseId, value)}
        aria-labelledby={getTabId(context.baseId, value)}
        hidden={!isActive}
        tabIndex={0}
        ref={ref}
        className={cn('mt-3', className)}
        {...props}
      />
    );
  },
);
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsContent, TabsList, TabsTrigger };
