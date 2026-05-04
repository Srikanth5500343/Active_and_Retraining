import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
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

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <ShutterProvider>
            <Routes>
            <Route path="/" element={<><HomePage /><BottomNav /></>} />
            <Route path="/login"  element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/scan" element={
              <ProtectedRoute><><ScanPage /><BottomNav /></></ProtectedRoute>
            } />
            <Route path="/profile" element={
              <ProtectedRoute><><ProfilePage /><BottomNav /></></ProtectedRoute>
            } />
            {/* Old /history URLs redirect to the new combined profile page. */}
            <Route path="/history" element={<Navigate to="/profile" replace />} />
            <Route path="/results" element={
              <ProtectedRoute><ResultsPage /></ProtectedRoute>
            } />
            <Route path="/results/:rackId/ports" element={
              <ProtectedRoute><PortsPage /></ProtectedRoute>
            } />
            <Route path="/results/:rackId/topology" element={
              <ProtectedRoute><TopologyPage /></ProtectedRoute>
            } />
            <Route path="/results/:rackId/netdisco" element={
              <ProtectedRoute><NetdiscoPage /></ProtectedRoute>
            } />
            <Route path="/compare" element={<LogoCompare />} />
            <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ShutterProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
