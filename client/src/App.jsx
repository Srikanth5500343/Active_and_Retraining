import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import BottomNav from './components/BottomNav.jsx';
import HomePage from './pages/HomePage.jsx';
import ScanPage from './pages/ScanPage.jsx';
import ResultsPage from './pages/ResultsPage.jsx';
import PortsPage from './pages/PortsPage.jsx';
import TopologyPage from './pages/TopologyPage.jsx';
import NetdiscoPage from './pages/NetdiscoPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import LogoCompare from './pages/LogoCompare.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SignupPage from './pages/SignupPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import SpecificationsPage from './pages/SpecificationsPage.jsx';
import FirmwarePage from './pages/FirmwarePage.jsx';
import SwitchInformationPage from './pages/SwitchInformationPage.jsx';
import MultiRackTopologyPage from './pages/MultiRackTopologyPage.jsx';
import MultiRackRedirect from './pages/MultiRackRedirect.jsx';
import PortHistoryPage from './pages/PortHistoryPage.jsx';
import TenantMatPage from './pages/TenantMatPage.jsx';
import BenchmarkPage from './pages/BenchmarkPage.jsx';
import VRPage from './pages/VRPage.jsx';
import { ShutterProvider } from './ShutterContext.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { ThemeProvider } from './ThemeContext.jsx';

// Bounces unauthenticated visitors to /login, remembering where they were
// trying to go so we can send them back after login/signup.
function ProtectedRoute({ children }) {
  const { isAuthed } = useAuth();
  const location = useLocation();
  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

// Bridges Android's hardware back button to React Router. Without this, the
// system back closes the WebView activity (kicks user to launcher) instead of
// walking the SPA history. Root pages exit the app explicitly.
function AndroidBackHandler() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let sub;
    (async () => {
      sub = await CapApp.addListener('backButton', () => {
        if (location.pathname === '/' || location.pathname === '/login') {
          CapApp.exitApp();
        } else {
          navigate(-1);
        }
      });
    })();
    return () => { sub?.remove?.(); };
  }, [navigate, location.pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <ShutterProvider>
            <AndroidBackHandler />
            <Routes>
            <Route path="/" element={<><HomePage /><BottomNav /></>} />
            <Route path="/benchmark" element={<BenchmarkPage />} />
            <Route path="/login"  element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/scan" element={
              <ProtectedRoute><><ScanPage /><BottomNav /></></ProtectedRoute>
            } />
            {/* Legacy multi-rack landing → redirect to first member rack's
                Ports page (the rack-tabs strip there lets the user reach
                every other rack in the group + the combined 3D topology). */}
            <Route path="/multi-rack/:groupId" element={
              <ProtectedRoute><MultiRackRedirect /></ProtectedRoute>
            } />
            <Route path="/multi-rack/:groupId/topology" element={
              <ProtectedRoute><MultiRackTopologyPage /></ProtectedRoute>
            } />
            <Route path="/profile" element={
              <ProtectedRoute><><ProfilePage /><BottomNav /></></ProtectedRoute>
            } />
            <Route path="/specifications" element={
              <ProtectedRoute><><SpecificationsPage /><BottomNav /></></ProtectedRoute>
            } />
            <Route path="/firmware" element={
              <ProtectedRoute><><FirmwarePage /><BottomNav /></></ProtectedRoute>
            } />
            {/* CMDB-driven switch list. /switch-info reads rackId from
                location.state; /switch-info/:rackId is the deep-link form. */}
            <Route path="/switch-info" element={
              <ProtectedRoute><><SwitchInformationPage /><BottomNav /></></ProtectedRoute>
            } />
            <Route path="/switch-info/:rackId" element={
              <ProtectedRoute><><SwitchInformationPage /><BottomNav /></></ProtectedRoute>
            } />
            {/* Old /history URLs redirect to the new combined profile page. */}
            <Route path="/history" element={<Navigate to="/profile" replace />} />
            <Route path="/results" element={
              <ProtectedRoute><ResultsPage /></ProtectedRoute>
            } />
            {/* Deep-linkable variant — when state.result is absent (cold link
                or rack-tab switch in a multi-rack scan), ResultsPage uses
                useParams + /api/scan/:rackId to populate itself. */}
            <Route path="/results/:rackId" element={
              <ProtectedRoute><ResultsPage /></ProtectedRoute>
            } />
            <Route path="/results/:rackId/ports" element={
              <ProtectedRoute><PortsPage /></ProtectedRoute>
            } />
            <Route path="/vr" element={
              <ProtectedRoute><VRPage /></ProtectedRoute>
            } />
            <Route path="/results/:rackId/vr" element={
              <ProtectedRoute><VRPage /></ProtectedRoute>
            } />
            <Route path="/results/:rackId/topology" element={
              <ProtectedRoute><TopologyPage /></ProtectedRoute>
            } />
            <Route path="/results/:rackId/netdisco" element={
              <ProtectedRoute><NetdiscoPage /></ProtectedRoute>
            } />
            <Route path="/port-history" element={
              <ProtectedRoute><><PortHistoryPage /><BottomNav /></></ProtectedRoute>
            } />
            <Route path="/compare" element={<LogoCompare />} />
            {/* Demo: unified tenant rack-layout view. No auth — backed by
                server/data/demo_tenant.json, isolated from real scan data. */}
            <Route path="/demo/topology" element={<TenantMatPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ShutterProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
