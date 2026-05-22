package com.racktrack.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom Capacitor plugins BEFORE super.onCreate so the
        // Bridge picks them up. Mirrors the iOS plugin auto-discovery.
        registerPlugin(RackARPlugin.class);
        registerPlugin(OrtNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
