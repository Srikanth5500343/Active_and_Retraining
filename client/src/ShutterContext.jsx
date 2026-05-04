import { createContext, useCallback, useContext, useState } from 'react';

const ShutterContext = createContext(null);

export function ShutterProvider({ children }) {
  const [state, setState] = useState({ fn: null, canShoot: false });

  const registerShutter = useCallback((fn, canShoot) => {
    setState({ fn, canShoot });
  }, []);

  const clearShutter = useCallback(() => {
    setState({ fn: null, canShoot: false });
  }, []);

  return (
    <ShutterContext.Provider value={{ ...state, registerShutter, clearShutter }}>
      {children}
    </ShutterContext.Provider>
  );
}

export function useShutter() {
  return useContext(ShutterContext);
}
