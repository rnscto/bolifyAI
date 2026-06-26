
// GET /api/reseller/custom-domain
resellerRouter.get("/custom-domain", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    if (user.role !== "reseller" && user.role !== "master_reseller") {
      return c.json({ error: "Only resellers can view custom domains" }, 403);
    }
    const mappings = await base44.entities.DomainMapping.filter({ reseller_id: user.client_id });
    return c.json(mappings.length > 0 ? mappings[0] : null);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
