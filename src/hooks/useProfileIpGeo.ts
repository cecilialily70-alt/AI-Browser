import { useMemo } from "react";

import { buildProfileIpGeoMap } from "../lib/ipGeo";
import { profileHasProxy } from "../lib/proxy";
import type { Profile, ProfileIpGeo } from "../types";

/**
 * 国家/IP 仅在操作栏点击「启动」后写入 overrides，不在页面加载时自动查询。
 */
export function useProfileIpGeo(profiles: Profile[], overrides?: Map<string, ProfileIpGeo>) {
  const map = useMemo(() => {
    const merged = new Map<string, ProfileIpGeo>();

    for (const profile of profiles) {
      const profileId = String(profile.id);
      if (overrides?.has(profileId)) {
        merged.set(profileId, overrides.get(profileId)!);
        continue;
      }
      if (!profileHasProxy(profile)) {
        merged.set(profileId, {
          profile_id: profileId,
          ip: null,
          country: null,
          country_code: null,
          status: "no_proxy",
        });
      }
    }

    if (overrides) {
      for (const [profileId, entry] of overrides) {
        merged.set(profileId, entry);
      }
    }

    return buildProfileIpGeoMap([...merged.values()]);
  }, [profiles, overrides]);

  return { map, loading: false };
}
