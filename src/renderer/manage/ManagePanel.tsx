import { memo, useState } from 'react';
import { Brain, Plug, FolderTree, CalendarClock, Settings, MessageSquare } from 'lucide-react';
import { ChatList, type ChatListProps } from '../chats/ChatList';
import { MemoryTab } from './tabs/MemoryTab';
import { McpSkillsTab } from './tabs/McpTab';
import { FoldersTab } from './tabs/FoldersTab';
import { TasksTab } from './tabs/TasksTab';
import { SettingsTab } from './tabs/SettingsTab';
import type { ModelTabProps, ActiveFactsViewProps } from './tabs/shared';

type Tab = 'chats' | 'memory' | 'mcp' | 'folders' | 'tasks' | 'settings';

const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'mcp', label: 'MCP & Skills', icon: Plug },
  { id: 'folders', label: 'Folders', icon: FolderTree },
  { id: 'tasks', label: 'Tasks', icon: CalendarClock },
  { id: 'settings', label: 'Settings', icon: Settings }
];

export type ManagePanelProps = ChatListProps &
  ModelTabProps &
  ActiveFactsViewProps & {
    /** A signed-in provider whose credential is dead — flags Settings with a red dot. */
    authDeadProvider?: string | null;
  };

function ManagePanelImpl({
  models,
  modelId,
  onSelectModel,
  activeThreadId,
  activeRunning,
  previewActive,
  previewDraft,
  onTogglePreview,
  authDeadProvider,
  ...chatProps
}: ManagePanelProps) {
  const activeFacts: ActiveFactsViewProps = {
    activeThreadId,
    activeRunning,
    previewActive,
    previewDraft,
    onTogglePreview
  };
  const [tab, setTab] = useState<Tab>('chats');
  return (
    <div className="manage">
      <div className="insp-tabs">
        <div className="insp-seg">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              title={id === 'settings' && authDeadProvider ? `${label} — a provider needs reconnecting` : label}
              aria-label={label}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              {id === 'settings' && authDeadProvider && <span className="tab-alert-dot" />}
            </button>
          ))}
        </div>
      </div>
      <div className={`manage-body${tab === 'chats' ? ' chats' : ''}`}>
        {tab === 'chats' && <ChatList {...chatProps} activeThreadId={activeThreadId} />}
        {tab === 'memory' && <MemoryTab models={models} activeFacts={activeFacts} />}
        {tab === 'mcp' && <McpSkillsTab models={models} />}
        {tab === 'folders' && <FoldersTab />}
        {tab === 'tasks' && <TasksTab onOpenChat={chatProps.onOpen} />}
        {tab === 'settings' && (
          <SettingsTab
            models={models}
            modelId={modelId}
            onSelectModel={onSelectModel}
            deadProvider={authDeadProvider}
          />
        )}
      </div>
    </div>
  );
}

// Memoized: App re-renders on every streamed frame (thread state lives there),
// and this panel is the whole right-hand side. Its props are kept referentially
// stable at streaming time (see threadStatuses/useShallowStable in App), so the
// memo actually holds during a reply.
export const ManagePanel = memo(ManagePanelImpl);
