import React from 'react';
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, X, ShoppingBag, Briefcase, Star, Zap } from 'lucide-react';

function ItemList({ items, setItems, fields, title, icon: Icon, emptyItem }) {
  const addItem = () => setItems([...items, { ...emptyItem }]);
  const removeItem = (i) => setItems(items.filter((_, idx) => idx !== i));
  const updateItem = (i, key, val) => {
    const updated = [...items];
    updated[i] = { ...updated[i], [key]: val };
    setItems(updated);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-lg">
          <span className="flex items-center gap-2"><Icon className="w-5 h-5 text-blue-600" /> {title}</span>
          <Button size="sm" variant="outline" onClick={addItem}><Plus className="w-4 h-4 mr-1" /> Add</Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.length === 0 && <p className="text-sm text-gray-400">No items added yet. Click "Add" to get started.</p>}
        {items.map((item, i) => (
          <div key={i} className="border rounded-lg p-3 space-y-2 relative">
            <button onClick={() => removeItem(i)} className="absolute top-2 right-2 text-gray-400 hover:text-red-500"><X className="w-4 h-4" /></button>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pr-6">
              {fields.map(f => (
                <div key={f.key} className={f.full ? 'sm:col-span-2' : ''}>
                  <Label className="text-xs">{f.label}</Label>
                  {f.type === 'textarea' ? (
                    <Textarea placeholder={f.placeholder} value={item[f.key] || ''} onChange={e => updateItem(i, f.key, e.target.value)} rows={2} className="text-sm" />
                  ) : (
                    <Input placeholder={f.placeholder} value={item[f.key] || ''} onChange={e => updateItem(i, f.key, e.target.value)} className="text-sm" />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function TagList({ items, setItems, label, placeholder, icon: Icon }) {
  const [val, setVal] = React.useState('');
  const add = () => {
    if (val.trim() && !items.includes(val.trim())) { setItems([...items, val.trim()]); setVal(''); }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg"><Icon className="w-5 h-5 text-amber-600" /> {label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {items.map(t => (
            <Badge key={t} variant="secondary" className="gap-1">{t} <button onClick={() => setItems(items.filter(x => x !== t))}><X className="w-3 h-3" /></button></Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input placeholder={placeholder} value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())} />
          <Button size="sm" variant="outline" onClick={add}><Plus className="w-4 h-4" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProductsServicesTab({ form, setForm }) {
  return (
    <div className="space-y-6">
      <ItemList
        title="Products"
        icon={ShoppingBag}
        items={form.products || []}
        setItems={v => setForm(f => ({ ...f, products: v }))}
        emptyItem={{ name: '', description: '', price: '' }}
        fields={[
          { key: 'name', label: 'Product Name', placeholder: 'e.g., Premium Yoga Mat' },
          { key: 'price', label: 'Price', placeholder: '₹1,999' },
          { key: 'description', label: 'Description', placeholder: 'Brief product description...', type: 'textarea', full: true },
        ]}
      />

      <ItemList
        title="Services"
        icon={Briefcase}
        items={form.services || []}
        setItems={v => setForm(f => ({ ...f, services: v }))}
        emptyItem={{ name: '', description: '', price: '' }}
        fields={[
          { key: 'name', label: 'Service Name', placeholder: 'e.g., Personal Training Session' },
          { key: 'price', label: 'Price', placeholder: '₹500/session' },
          { key: 'description', label: 'Description', placeholder: 'Service details...', type: 'textarea', full: true },
        ]}
      />

      <TagList
        label="USPs (Unique Selling Points)"
        icon={Star}
        items={form.usps || []}
        setItems={v => setForm(f => ({ ...f, usps: v }))}
        placeholder="e.g., 100% organic ingredients"
      />

      <TagList
        label="Key Features"
        icon={Zap}
        items={form.features || []}
        setItems={v => setForm(f => ({ ...f, features: v }))}
        placeholder="e.g., Free delivery, 24/7 support"
      />

      {/* Pricing & Offers */}
      <Card>
        <CardHeader><CardTitle className="text-lg">Pricing & Discounts</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>General Pricing Info</Label>
            <Textarea placeholder="e.g., Plans start from ₹999/month. Volume discounts available for bulk orders..." value={form.pricing_info || ''} onChange={e => setForm(f => ({ ...f, pricing_info: e.target.value }))} rows={2} />
          </div>
        </CardContent>
      </Card>

      <ItemList
        title="Current Offers & Discounts"
        icon={ShoppingBag}
        items={form.current_offers || []}
        setItems={v => setForm(f => ({ ...f, current_offers: v }))}
        emptyItem={{ title: '', description: '', code: '', valid_until: '' }}
        fields={[
          { key: 'title', label: 'Offer Title', placeholder: 'Summer Sale 30% Off' },
          { key: 'code', label: 'Promo Code', placeholder: 'SUMMER30' },
          { key: 'description', label: 'Description', placeholder: 'Flat 30% off on all products...', full: true },
          { key: 'valid_until', label: 'Valid Until', placeholder: '2026-04-30' },
        ]}
      />
    </div>
  );
}