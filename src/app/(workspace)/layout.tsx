import { requireSession } from '@/server/auth/guards';
import { getWorkspace } from '@/server/workspace/service';
import { notifications } from '@/server/notifications';
import { toView } from '@/lib/presentation';
import { WorkspaceProvider } from '@/context/workspace';
import { AskSeedProvider } from '@/context/NavContext';
import { ToastProvider } from '@/context/toast';
import { CompanyWorkspace } from '@/components/CompanyWorkspace';
import { Sidebar } from '@/components/Sidebar';
import { activeBrand } from '@/server/brain/activeBrand';

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
  const [workspace, notices, brandLens] = await Promise.all([
    getWorkspace(session),
    // Counted on the server so the badge is right on the first paint rather
    // than appearing a moment later.
    notifications(session.scope),
    // The brand chosen in the sidebar, checked against this company's roster.
    activeBrand(session.scope),
  ]);

  return (
    <WorkspaceProvider workspace={toView(workspace)}>
      <AskSeedProvider>
        <ToastProvider>
          <CompanyWorkspace>
            <Sidebar
              notices={notices}
              brands={brandLens.brands.map((brand) => brand.name)}
              activeBrand={brandLens.active}
            />
            <div className="main">
              <main className="page">{children}</main>
            </div>
          </CompanyWorkspace>
        </ToastProvider>
      </AskSeedProvider>
    </WorkspaceProvider>
  );
}
