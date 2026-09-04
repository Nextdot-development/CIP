import { requireSession } from '@/server/auth/guards';
import { getWorkspace } from '@/server/workspace/service';
import { toView } from '@/lib/presentation';
import { WorkspaceProvider } from '@/context/workspace';
import { AskSeedProvider } from '@/context/NavContext';
import { ToastProvider } from '@/context/toast';
import { CompanyWorkspace } from '@/components/CompanyWorkspace';
import { Sidebar } from '@/components/Sidebar';

/**
 * The workspace shell.
 *
 * This runs on the server on every request: it proves the session, resolves
 * the one company that session may see, loads that company's data and hands
 * the result down as props. The browser never asks for a company and never
 * receives another one — the fixtures that used to ship in the bundle are gone
 * along with the file they lived in.
 */
export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const workspace = await getWorkspace(session);

  return (
    <WorkspaceProvider workspace={toView(workspace)}>
      <AskSeedProvider>
        <ToastProvider>
          <CompanyWorkspace>
            <Sidebar />
            <div className="main">
              <main className="page">{children}</main>
            </div>
          </CompanyWorkspace>
        </ToastProvider>
      </AskSeedProvider>
    </WorkspaceProvider>
  );
}
