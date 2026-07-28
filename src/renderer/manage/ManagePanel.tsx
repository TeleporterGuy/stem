import { memo, useState } from 'react';
import { Brain, Plug, FolderTree, CalendarClock, Settings, MessageSquare } from 'lucide-react';
import { ChatList, type ChatListProps } from '../chats/ChatList';
import { MemoryTab } from './tabs/MemoryTab';
import { McpSkillsTab } from './tabs/McpTab';
import { SourcesTab } from './tabs/FoldersTab';
import { TasksTab } from './tabs/TasksTab';
import { SettingsTab } from './tabs/SettingsTab';
import type { ModelTabProps, ActiveFactsViewProps } from './tabs/shared';

type Tab = 'chats' | 'memory' | 'mcp' | 'folders' | 'tasks' | 'settings';

// Naming notes: "Tools", not "MCP" — the tab holds skills as well as MCP servers.
// "Sources", not "Folders" — the Chats tab already organizes threads into folders,
// so a second tab called Folders (connected filesystem dirs) collided with it.
// Sources covers both places the assistant reads from: the Files drop-place and
// connected folders, as sub-tabs.
const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'mcp', label: 'Tools — MCP & skills', icon: Plug },
  { id: 'folders', label: 'Sources — files & connected folders', icon: FolderTree },
  { id: 'tasks', label: 'Scheduled tasks', icon: CalendarClock },
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
              aria-label={label}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              {/* Styled hover/focus tooltip replaces the native title (which is
                  slow to appear and can't be styled). aria-hidden: the button's
                  aria-label already carries the name. */}
              <span className="insp-tab-tip" aria-hidden="true">
                {id === 'settings' && authDeadProvider ? `${label} — a provider needs reconnecting` : label}
              </span>
              {id === 'settings' && authDeadProvider && <span className="tab-alert-dot" />}
            </button>
          ))}
        </div>
      </div>
      <div className={`manage-body${tab === 'chats' ? ' chats' : ''}`}>
        {tab === 'chats' && <ChatList {...chatProps} activeThreadId={activeThreadId} />}
        {tab === 'memory' && <MemoryTab models={models} activeFacts={activeFacts} />}
        {tab === 'mcp' && <McpSkillsTab models={models} />}
        {tab === 'folders' && <SourcesTab models={models} />}
        {tab === 'tasks' && <TasksTab onOpenChat={chatProps.onOpen} models={models} />}
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
