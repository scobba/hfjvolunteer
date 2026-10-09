/** AuditLog: timestamp, actor, action, entity, details. Append-only. */

function logAudit_(actor, action, entity, entityId, details) {
  appendRow_(TABS.AUDIT, {
    Timestamp: new Date(),
    Actor: actor && actor.email ? actor.email : String(actor || 'system'),
    Action: action,
    Entity: entity,
    EntityID: entityId || '',
    Details: typeof details === 'string' ? details : JSON.stringify(details || {})
  });
}

/** Field-by-field description of what changed, for the audit Details column. */
function describeChanges_(before, after, fields) {
  var parts = [];
  fields.forEach(function (f) {
    if (!(f in after)) return;
    var a = before ? before[f] : '';
    var b = after[f];
    if (String(a === undefined ? '' : a) !== String(b === undefined ? '' : b)) {
      parts.push(f + ': "' + (a === undefined ? '' : a) + '" → "' + b + '"');
    }
  });
  return parts.join('; ');
}
