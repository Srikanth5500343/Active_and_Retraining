"""
ServiceNow REST client.

Uses the Table API — the standard REST endpoint ServiceNow exposes for every
table (incident, cmdb_ci_*, cmdb_rel_ci). Basic auth is fine for a PDI.
"""
import requests


class ServiceNowClient:
    def __init__(self, instance: str, user: str, password: str):
        self.base = f"https://{instance}.service-now.com/api/now"
        self.auth = (user, password)
        self.headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def _get(self, path: str, params: dict | None = None) -> dict:
        r = requests.get(
            f"{self.base}{path}",
            params=params or {},
            auth=self.auth,
            headers=self.headers,
            timeout=15,
        )
        r.raise_for_status()
        return r.json()

    def _patch(self, path: str, payload: dict) -> dict:
        r = requests.patch(
            f"{self.base}{path}",
            json=payload,
            auth=self.auth,
            headers=self.headers,
            timeout=20,
        )
        r.raise_for_status()
        return r.json().get("result", {})

    def get_incident(self, number: str) -> dict | None:
        """Fetch an incident by its human-readable number (e.g. INC0010001)."""
        data = self._get(
            "/table/incident",
            {"sysparm_query": f"number={number}", "sysparm_limit": 1},
        )
        results = data.get("result", [])
        return results[0] if results else None

    def get_ci(self, sys_id: str) -> dict | None:
        """Fetch any CI by its sys_id, returning subclass-specific fields.

        The generic /table/cmdb_ci/ endpoint only returns base-class columns,
        so custom fields added to subclass tables (like u_racktrack_scan_id on
        cmdb_ci_rack) come back as None. We first ask cmdb_ci for sys_class_name,
        then re-fetch from the real table.
        """
        data = self._get(f"/table/cmdb_ci/{sys_id}")
        base = data.get("result")
        if not base:
            return None
        cls = base.get("sys_class_name")
        if not cls or cls == "cmdb_ci":
            return base
        data = self._get(f"/table/{cls}/{sys_id}")
        return data.get("result") or base

    def get_parent_rack(self, child_sys_id: str) -> dict | None:
        """Walk cmdb_rel_ci to find the rack that contains the given CI.

        Looks for rows where child=<our sys_id> and the parent is a rack.
        Returns the rack CI dict, or None if no containing rack is found.
        """
        data = self._get(
            "/table/cmdb_rel_ci",
            {
                "sysparm_query": (
                    f"child={child_sys_id}"
                    f"^parent.sys_class_name=cmdb_ci_rack"
                ),
                "sysparm_limit": 1,
            },
        )
        rels = data.get("result", [])
        if not rels:
            return None
        parent_ref = rels[0].get("parent")
        if not parent_ref or not parent_ref.get("value"):
            return None
        return self.get_ci(parent_ref["value"])

    def get_rack_children(self, rack_sys_id: str) -> list[dict]:
        """Get all CIs contained in the given rack. Used for the 'neighbors'
        section of the work note."""
        data = self._get(
            "/table/cmdb_rel_ci",
            {
                "sysparm_query": f"parent={rack_sys_id}",
                "sysparm_limit": 100,
            },
        )
        rels = data.get("result", [])
        children = []
        for rel in rels:
            child_ref = rel.get("child")
            if child_ref and child_ref.get("value"):
                ci = self.get_ci(child_ref["value"])
                if ci:
                    children.append(ci)
        return children

    def add_work_note(self, incident_sys_id: str, note: str) -> dict:
        """Append a work note to the given incident. ServiceNow's work_notes
        field is append-only — setting it adds a new entry, it doesn't replace."""
        r = requests.patch(
            f"{self.base}/table/incident/{incident_sys_id}",
            json={"work_notes": note},
            auth=self.auth,
            headers=self.headers,
            timeout=15,
        )
        r.raise_for_status()
        return r.json().get("result", {})
