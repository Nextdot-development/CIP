import { TenantProvider } from './context/TenantContext';
import { AppShell } from './components/AppShell';
import './styles/index.css';

export default function App() {
  return (
    <TenantProvider>
      <AppShell />
    </TenantProvider>
  );
}
