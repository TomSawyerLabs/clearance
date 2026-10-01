import {
  Anchor,
  AppShell,
  Burger,
  Container,
  Group,
  NavLink,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { AccountPage } from "./pages/Account.tsx";
import { AuditPage } from "./pages/admin/Audit.tsx";
import { ClearancePage } from "./pages/admin/Clearance.tsx";
import { ClearancesPage } from "./pages/admin/Clearances.tsx";
import { SettingsPage } from "./pages/admin/Settings.tsx";
import { UsersPage } from "./pages/admin/Users.tsx";
import { GroupPage } from "./pages/Group.tsx";
import { GroupsPage } from "./pages/Groups.tsx";
import { HomePage } from "./pages/Home.tsx";
import { JoinPage } from "./pages/Join.tsx";
import { PersonPage } from "./pages/Person.tsx";
import { RecordPage } from "./pages/Record.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { SignPage } from "./pages/Sign.tsx";
import { WelcomePage } from "./pages/Welcome.tsx";
import { useSite } from "./site.tsx";

function Shell({ children }: { children: ReactNode }) {
  const { state } = useSite();
  const [opened, { toggle, close }] = useDisclosure(false);
  const { pathname } = useLocation();
  const me = state.me;

  const links: { to: string; label: string }[] = me
    ? [
        { to: "/", label: "My clearances" },
        { to: "/groups", label: "Groups" },
        ...(me.admin
          ? [
              { to: "/admin/clearances", label: "Documents" },
              { to: "/admin/users", label: "People" },
              { to: "/admin/settings", label: "Settings" },
              { to: "/admin/audit", label: "Audit log" },
            ]
          : []),
        { to: "/account", label: "Account" },
      ]
    : [];

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: 220,
        breakpoint: "sm",
        collapsed: { mobile: !opened, desktop: !me },
      }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            {me && (
              <Burger
                opened={opened}
                onClick={toggle}
                hiddenFrom="sm"
                size="sm"
                aria-label="Menu"
              />
            )}
            <Anchor
              component={Link}
              to="/"
              underline="never"
              c="inherit"
              fw={700}
              size="lg"
            >
              {state.site.name}
            </Anchor>
          </Group>
          {me && (
            <Text size="sm" c="dimmed" truncate>
              {me.name}
            </Text>
          )}
        </Group>
      </AppShell.Header>
      {me && (
        <AppShell.Navbar p="xs">
          {links.map((link) => (
            <NavLink
              key={link.to}
              component={Link}
              to={link.to}
              label={link.label}
              onClick={close}
              active={
                link.to === "/"
                  ? pathname === "/"
                  : pathname.startsWith(link.to)
              }
            />
          ))}
        </AppShell.Navbar>
      )}
      <AppShell.Main>
        <Container size="md" px={0}>
          {children}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}

/** Pages that need a signed-in person send everyone else to the welcome page, and back after. */
function Private({
  children,
  admin,
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const { state } = useSite();
  const location = useLocation();
  if (!state.me) {
    return (
      <Navigate
        to="/welcome"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  if (admin && !state.me.admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  const { state } = useSite();
  if (state.setupNeeded) {
    return (
      <Shell>
        <SetupPage />
      </Shell>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/join/:token" element={<JoinPage />} />
        <Route
          path="/"
          element={
            <Private>
              <HomePage />
            </Private>
          }
        />
        <Route
          path="/sign/:clearanceId/:subjectId"
          element={
            <Private>
              <SignPage />
            </Private>
          }
        />
        <Route
          path="/records/:id"
          element={
            <Private>
              <RecordPage />
            </Private>
          }
        />
        <Route
          path="/people/:id"
          element={
            <Private>
              <PersonPage />
            </Private>
          }
        />
        <Route
          path="/groups"
          element={
            <Private>
              <GroupsPage />
            </Private>
          }
        />
        <Route
          path="/groups/:id"
          element={
            <Private>
              <GroupPage />
            </Private>
          }
        />
        <Route
          path="/account"
          element={
            <Private>
              <AccountPage />
            </Private>
          }
        />
        <Route
          path="/admin/clearances"
          element={
            <Private admin>
              <ClearancesPage />
            </Private>
          }
        />
        <Route
          path="/admin/clearances/:id"
          element={
            <Private admin>
              <ClearancePage />
            </Private>
          }
        />
        <Route
          path="/admin/users"
          element={
            <Private admin>
              <UsersPage />
            </Private>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <Private admin>
              <SettingsPage />
            </Private>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <Private admin>
              <AuditPage />
            </Private>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
