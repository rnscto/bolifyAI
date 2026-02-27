import React from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2, Copy, Send } from 'lucide-react';

const CATEGORY_COLORS = {
  followup: 'bg-blue-100 text-blue-800',
  reminder: 'bg-orange-100 text-orange-800',
  promotion: 'bg-purple-100 text-purple-800',
  notification: 'bg-yellow-100 text-yellow-800',
  welcome: 'bg-green-100 text-green-800',
  custom: 'bg-gray-100 text-gray-800',
};

export default function RCSTemplateList({ templates, onEdit, onDelete, onDuplicate, onUse }) {
  if (!templates || templates.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400 text-sm">
        No templates yet. Create your first RCS template above.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {templates.map(t => (
        <div key={t.id} className="flex items-start gap-3 p-3 border rounded-lg hover:bg-gray-50 transition-colors">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium text-sm truncate">{t.name}</span>
              <Badge className={`text-[10px] ${CATEGORY_COLORS[t.category] || CATEGORY_COLORS.custom}`}>
                {t.category}
              </Badge>
              {t.status === 'draft' && <Badge variant="outline" className="text-[10px]">Draft</Badge>}
            </div>
            <p className="text-xs text-gray-500 truncate font-mono">{t.body}</p>
            <div className="flex items-center gap-3 mt-1">
              {t.variables?.length > 0 && (
                <span className="text-[10px] text-gray-400">{t.variables.length} variable{t.variables.length > 1 ? 's' : ''}</span>
              )}
              {t.usage_count > 0 && (
                <span className="text-[10px] text-gray-400">Used {t.usage_count}×</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onUse(t)} title="Send with template">
              <Send className="w-3.5 h-3.5 text-green-600" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDuplicate(t)} title="Duplicate">
              <Copy className="w-3.5 h-3.5 text-gray-500" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(t)} title="Edit">
              <Pencil className="w-3.5 h-3.5 text-blue-600" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDelete(t)} title="Delete">
              <Trash2 className="w-3.5 h-3.5 text-red-500" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}