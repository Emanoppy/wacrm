'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface TagRow {
  id: string;
  name: string;
  color: string;
}

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  sale_price: number | null;
  cost: number | null;
  description: string | null;
  technical_spec: string | null;
  image_urls: string[];
  niche_tag_id: string | null;
}

const NO_NICHE = '__none__';

const emptyForm = {
  name: '',
  sku: '',
  salePrice: '',
  cost: '',
  description: '',
  technicalSpec: '',
  nicheTagId: NO_NICHE,
  imageUrls: [] as string[],
};

export default function ProductsPage() {
  const t = useTranslations('Products.page');
  const supabase = createClient();
  const canEdit = useCan('send-messages');

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tagsById = Object.fromEntries(tags.map((tg) => [tg.id, tg]));

  const loadProducts = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('products')
      .select(
        'id, name, sku, sale_price, cost, description, technical_spec, image_urls, niche_tag_id',
      )
      .order('created_at', { ascending: false });
    if (error) toast.error(error.message);
    setProducts((data as ProductRow[]) ?? []);
    setLoading(false);
  }, [supabase]);

  const loadTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('id, name, color').order('name');
    setTags((data as TagRow[]) ?? []);
  }, [supabase]);

  useEffect(() => {
    void loadProducts();
    void loadTags();
  }, [loadProducts, loadTags]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(p: ProductRow) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      sku: p.sku ?? '',
      salePrice: p.sale_price != null ? String(p.sale_price) : '',
      cost: p.cost != null ? String(p.cost) : '',
      description: p.description ?? '',
      technicalSpec: p.technical_spec ?? '',
      nicheTagId: p.niche_tag_id ?? NO_NICHE,
      imageUrls: p.image_urls ?? [],
    });
    setDialogOpen(true);
  }

  async function handleImageSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error(t('imageTooLarge'));
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia('product-media', file);
      setForm((f) => ({ ...f, imageUrls: [...f.imageUrls, publicUrl] }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  function removeImage(url: string) {
    setForm((f) => ({ ...f, imageUrls: f.imageUrls.filter((u) => u !== url) }));
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast.error(t('missingName'));
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        sku: form.sku.trim() || null,
        sale_price: form.salePrice ? Number(form.salePrice) : null,
        cost: form.cost ? Number(form.cost) : null,
        description: form.description.trim() || null,
        technical_spec: form.technicalSpec.trim() || null,
        niche_tag_id: form.nicheTagId === NO_NICHE ? null : form.nicheTagId,
        image_urls: form.imageUrls,
      };
      const res = editingId
        ? await fetch(`/api/products/${editingId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      if (data.warning) toast.warning(data.warning);
      toast.success(t('saveSuccess'));
      setDialogOpen(false);
      await loadProducts();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/products/${deleteTarget.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('deleteFailed'));
        return;
      }
      toast.success(t('deleteSuccess'));
      setDeleteTarget(null);
      await loadProducts();
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <GatedButton canAct={canEdit} gateReason="create products" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          {t('newProduct')}
        </GatedButton>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-muted/50" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
          <Package className="h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium text-foreground">{t('noProductsYet')}</h3>
          <p className="mt-2 max-w-sm text-center text-sm text-muted-foreground">
            {t('noProductsDesc')}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colProduct')}</TableHead>
                <TableHead>{t('colSku')}</TableHead>
                <TableHead>{t('colPrice')}</TableHead>
                <TableHead>{t('colCost')}</TableHead>
                <TableHead>{t('colNiche')}</TableHead>
                <TableHead className="text-right">{t('colActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => {
                const niche = p.niche_tag_id ? tagsById[p.niche_tag_id] : null;
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {p.image_urls?.[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.image_urls[0]}
                            alt=""
                            className="h-8 w-8 rounded object-cover"
                          />
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded bg-muted">
                            <Package className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}
                        {p.name}
                      </div>
                    </TableCell>
                    <TableCell>{p.sku ?? '—'}</TableCell>
                    <TableCell>{p.sale_price != null ? p.sale_price.toLocaleString() : '—'}</TableCell>
                    <TableCell>{p.cost != null ? p.cost.toLocaleString() : '—'}</TableCell>
                    <TableCell>
                      {niche ? (
                        <Badge style={{ backgroundColor: `${niche.color}20`, borderColor: `${niche.color}40`, color: niche.color }}>
                          {niche.name}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(p)} disabled={!canEdit}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(p)}
                        disabled={!canEdit}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? t('editProduct') : t('newProduct')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="p-name">{t('fieldName')}</Label>
                <Input
                  id="p-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  disabled={saving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-sku">{t('fieldSku')}</Label>
                <Input
                  id="p-sku"
                  value={form.sku}
                  onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="p-price">{t('fieldSalePrice')}</Label>
                <Input
                  id="p-price"
                  type="number"
                  value={form.salePrice}
                  onChange={(e) => setForm((f) => ({ ...f, salePrice: e.target.value }))}
                  disabled={saving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-cost">{t('fieldCost')}</Label>
                <p className="text-xs text-muted-foreground">{t('fieldCostHint')}</p>
                <Input
                  id="p-cost"
                  type="number"
                  value={form.cost}
                  onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('fieldNiche')}</Label>
              <Select
                value={form.nicheTagId}
                onValueChange={(v) => setForm((f) => ({ ...f, nicheTagId: v ?? NO_NICHE }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_NICHE}>{t('noNiche')}</SelectItem>
                  {tags.map((tg) => (
                    <SelectItem key={tg.id} value={tg.id}>
                      {tg.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('fieldNicheHint')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="p-desc">{t('fieldDescription')}</Label>
              <Textarea
                id="p-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                disabled={saving}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="p-spec">{t('fieldTechnicalSpec')}</Label>
              <p className="text-xs text-muted-foreground">{t('fieldTechnicalSpecHint')}</p>
              <Textarea
                id="p-spec"
                value={form.technicalSpec}
                onChange={(e) => setForm((f) => ({ ...f, technicalSpec: e.target.value }))}
                rows={5}
                disabled={saving}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('fieldImages')}</Label>
              <div className="flex flex-wrap gap-2">
                {form.imageUrls.map((url) => (
                  <div key={url} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="" className="h-16 w-16 rounded object-cover" />
                    <button
                      type="button"
                      onClick={() => removeImage(url)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || saving}
                  className="flex h-16 w-16 items-center justify-center rounded border border-dashed border-border text-muted-foreground hover:bg-muted"
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handleImageSelected}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving || uploading}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteConfirmTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('deleteConfirmDesc', { name: deleteTarget?.name ?? '' })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
