import os, sys
sys.path.insert(0, "/work")
import seed_netdisco as s
s.DB_CONFIG["host"] = os.environ.get("PGHOST", "netdisco-postgres-1")
s.main()
