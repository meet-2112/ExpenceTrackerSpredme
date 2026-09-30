import { Component, Injectable, Input, OnChanges, OnDestroy, OnInit, ElementRef, ViewChild, ViewEncapsulation, inject, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, Routes, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { HttpClient, HttpErrorResponse, HttpParams, provideHttpClient } from '@angular/common/http';
import { AbstractControl, FormBuilder, FormsModule, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { Subject, debounceTime } from 'rxjs';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

// ===================== Types & constants =====================
const API = 'http://localhost:3000/api';
const PAYMENT_METHODS = ['Cash', 'Credit Card', 'Debit Card', 'UPI', 'Other'];

interface Category { _id: string; name: string; }
interface Expense { _id: string; amount: number; category: Category; description: string; date: string; paymentMethod: string; }
interface PageResult { data: Expense[]; total: number; page: number; pages: number; limit: number; }

function errMsg(e: HttpErrorResponse): string {
  if (e.status === 0) return 'Cannot reach the server. Is the backend running on port 3000?';
  const b = e.error;
  if (b?.errors?.length) return b.errors.join(' • ');
  return b?.message || 'Something went wrong. Please try again.';
}
const todayStr = () => new Date().toISOString().substring(0, 10);

// ===================== API service =====================
@Injectable({ providedIn: 'root' })
class Api {
  private http = inject(HttpClient);
  categories = () => this.http.get<Category[]>(`${API}/categories`);
  addCategory = (name: string) => this.http.post<Category>(`${API}/categories`, { name });
  updateCategory = (id: string, name: string) => this.http.put<Category>(`${API}/categories/${id}`, { name });
  deleteCategory = (id: string) => this.http.delete(`${API}/categories/${id}`);
  expenses = (params: HttpParams) => this.http.get<PageResult>(`${API}/expenses`, { params });
  addExpense = (b: any) => this.http.post<Expense>(`${API}/expenses`, b);
  updateExpense = (id: string, b: any) => this.http.put<Expense>(`${API}/expenses/${id}`, b);
  deleteExpense = (id: string) => this.http.delete(`${API}/expenses/${id}`);
  dashboard = () => this.http.get<any>(`${API}/dashboard`);
}

// ===================== Chart wrapper =====================
@Component({
  selector: 'app-chart',
  standalone: true,
  template: `<div class="chart-box"><canvas #c></canvas></div>`,
})
class ChartComponent implements OnChanges, OnDestroy {
  @Input() type: 'bar' | 'doughnut' = 'bar';
  @Input() labels: string[] = [];
  @Input() values: number[] = [];
  @Input() title = '';
  @ViewChild('c', { static: true }) canvas!: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;
  private colors = ['#4f46e5', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#64748b'];

  ngOnChanges() {
    if (!this.canvas) return;
    this.chart?.destroy();
    this.chart = new Chart(this.canvas.nativeElement, {
      type: this.type,
      data: {
        labels: this.labels,
        datasets: [{
          label: this.title,
          data: this.values,
          backgroundColor: this.type === 'bar' ? '#4f46e5' : this.colors,
          borderRadius: this.type === 'bar' ? 6 : 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: this.type === 'doughnut', position: 'bottom' } },
      },
    });
  }
  ngOnDestroy() { this.chart?.destroy(); }
}

// ===================== Dashboard =====================
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [ChartComponent, CurrencyPipe, DatePipe],
  template: `
    <h2>Dashboard</h2>
    @if (error()) { <div class="alert bad">{{ error() }}</div> }
    @if (loading()) { <p class="muted">Loading…</p> }
    @if (d(); as d) {
      <div class="stats">
        <div class="card stat"><span>Total Expenses</span><b>{{ d.totalExpenses | currency:'INR':'symbol':'1.0-2' }}</b></div>
        <div class="card stat"><span>This Month</span><b>{{ d.currentMonth | currency:'INR':'symbol':'1.0-2' }}</b></div>
        <div class="card stat"><span>This Week</span><b>{{ d.currentWeek | currency:'INR':'symbol':'1.0-2' }}</b></div>
        <div class="card stat"><span>Transactions</span><b>{{ d.transactions }}</b></div>
        <div class="card stat">
          <span>Highest Expense</span>
          @if (d.highestExpense) {
            <b>{{ d.highestExpense.amount | currency:'INR':'symbol':'1.0-2' }}</b>
            <small>{{ d.highestExpense.category?.name }} • {{ d.highestExpense.date | date:'dd MMM yyyy':'UTC' }}</small>
          } @else { <b>—</b> }
        </div>
      </div>

      @if (d.transactions === 0) {
        <div class="card"><p class="muted">No expenses yet. Add your first expense from the Expenses page.</p></div>
      } @else {
        <div class="grid2">
          <div class="card"><h3>Category-wise</h3><app-chart type="doughnut" [labels]="catLabels()" [values]="catValues()" title="By category" /></div>
          <div class="card"><h3>Monthly (last 6 months)</h3><app-chart type="bar" [labels]="monLabels()" [values]="monValues()" title="Monthly total" /></div>
        </div>
        <div class="card">
          <h3>Category summary</h3>
          <table>
            <thead><tr><th>Category</th><th class="r">Transactions</th><th class="r">Total</th></tr></thead>
            <tbody>
              @for (c of d.byCategory; track c.category) {
                <tr><td>{{ c.category }}</td><td class="r">{{ c.count }}</td><td class="r">{{ c.total | currency:'INR':'symbol':'1.0-2' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    }
  `,
})
class DashboardComponent implements OnInit {
  private api = inject(Api);
  d = signal<any>(null);
  loading = signal(true);
  error = signal('');
  catLabels = signal<string[]>([]);
  catValues = signal<number[]>([]);
  monLabels = signal<string[]>([]);
  monValues = signal<number[]>([]);

  ngOnInit() {
    this.api.dashboard().subscribe({
      next: (d) => {
        this.catLabels.set(d.byCategory.map((c: any) => c.category));
        this.catValues.set(d.byCategory.map((c: any) => c.total));
        this.monLabels.set(d.monthly.map((m: any) => m.label));
        this.monValues.set(d.monthly.map((m: any) => m.total));
        this.d.set(d);
        this.loading.set(false);
      },
      error: (e) => { this.error.set(errMsg(e)); this.loading.set(false); },
    });
  }
}

// ===================== Categories =====================
@Component({
  selector: 'app-categories',
  standalone: true,
  imports: [FormsModule],
  template: `
    <h2>Categories</h2>
    @if (msg()) { <div class="alert ok">{{ msg() }}</div> }
    @if (error()) { <div class="alert bad">{{ error() }}</div> }
    <div class="card row">
      <input [(ngModel)]="newName" maxlength="50" placeholder="New category name" (keyup.enter)="add()" />
      <button class="btn" (click)="add()">Add</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th class="r">Actions</th></tr></thead>
        <tbody>
          @for (c of list(); track c._id) {
            <tr>
              <td>
                @if (editId() === c._id) { <input [(ngModel)]="editName" maxlength="50" (keyup.enter)="saveEdit(c)" /> }
                @else { {{ c.name }} }
              </td>
              <td class="r">
                @if (editId() === c._id) {
                  <button class="btn sm" (click)="saveEdit(c)">Save</button>
                  <button class="btn sm ghost" (click)="editId.set(null)">Cancel</button>
                } @else {
                  <button class="btn sm ghost" (click)="startEdit(c)">Edit</button>
                  <button class="btn sm danger" (click)="remove(c)">Delete</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="2" class="muted">No categories yet.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
class CategoriesComponent implements OnInit {
  private api = inject(Api);
  list = signal<Category[]>([]);
  msg = signal('');
  error = signal('');
  editId = signal<string | null>(null);
  newName = '';
  editName = '';

  ngOnInit() { this.load(); }
  private ok(m: string) { this.error.set(''); this.msg.set(m); }
  private bad(e: HttpErrorResponse) { this.msg.set(''); this.error.set(errMsg(e)); }
  load() { this.api.categories().subscribe({ next: (l) => this.list.set(l), error: (e) => this.bad(e) }); }

  add() {
    const name = this.newName.trim();
    if (!name) { this.bad({ status: 400, error: { message: 'Category name is required' } } as any); return; }
    this.api.addCategory(name).subscribe({
      next: () => { this.newName = ''; this.ok('Category added'); this.load(); },
      error: (e) => this.bad(e),
    });
  }
  startEdit(c: Category) { this.editId.set(c._id); this.editName = c.name; }
  saveEdit(c: Category) {
    const name = this.editName.trim();
    if (!name) { this.bad({ status: 400, error: { message: 'Category name is required' } } as any); return; }
    this.api.updateCategory(c._id, name).subscribe({
      next: () => { this.editId.set(null); this.ok('Category updated'); this.load(); },
      error: (e) => this.bad(e),
    });
  }
  remove(c: Category) {
    if (!confirm(`Delete category "${c.name}"?`)) return;
    this.api.deleteCategory(c._id).subscribe({
      next: () => { this.ok('Category deleted'); this.load(); },
      error: (e) => this.bad(e),
    });
  }
}

// ===================== Expenses =====================
const positive = (c: AbstractControl): ValidationErrors | null =>
  c.value === null || c.value === '' ? null : Number(c.value) > 0 ? null : { positive: true };
const validDate = (c: AbstractControl): ValidationErrors | null =>
  !c.value || !isNaN(Date.parse(c.value)) ? null : { badDate: true };

@Component({
  selector: 'app-expenses',
  standalone: true,
  imports: [FormsModule, ReactiveFormsModule, CurrencyPipe, DatePipe],
  template: `
    <div class="head"><h2>Expenses</h2><button class="btn" (click)="openForm()">+ Add Expense</button></div>
    @if (msg()) { <div class="alert ok">{{ msg() }}</div> }
    @if (error()) { <div class="alert bad">{{ error() }}</div> }

    @if (showForm()) {
      <form class="card formgrid" [formGroup]="form" (ngSubmit)="save()" novalidate>
        <h3 class="full">{{ editId() ? 'Edit' : 'Add' }} Expense</h3>
        <label>Amount (₹)
          <input type="number" step="0.01" formControlName="amount" />
          <small class="err">{{ fe('amount') }}</small>
        </label>
        <label>Category
          <select formControlName="category">
            <option value="">-- Select --</option>
            @for (c of cats(); track c._id) { <option [value]="c._id">{{ c.name }}</option> }
          </select>
          <small class="err">{{ fe('category') }}</small>
        </label>
        <label>Date
          <input type="date" formControlName="date" />
          <small class="err">{{ fe('date') }}</small>
        </label>
        <label>Payment Method
          <select formControlName="paymentMethod">
            <option value="">-- Select --</option>
            @for (p of payments; track p) { <option [value]="p">{{ p }}</option> }
          </select>
          <small class="err">{{ fe('paymentMethod') }}</small>
        </label>
        <label class="full">Description
          <input type="text" formControlName="description" maxlength="200" placeholder="Optional" />
          <small class="err">{{ fe('description') }}</small>
        </label>
        <div class="full">
          <button class="btn" type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save' }}</button>
          <button class="btn ghost" type="button" (click)="closeForm()">Cancel</button>
        </div>
      </form>
    }

    <div class="card filters">
      <input placeholder="Search description / category" [ngModel]="f['search']" (ngModelChange)="f['search'] = $event; search$.next()" />
      <select [ngModel]="f['category']" (ngModelChange)="set('category', $event)">
        <option value="">All categories</option>
        @for (c of cats(); track c._id) { <option [value]="c._id">{{ c.name }}</option> }
      </select>
      <select [ngModel]="f['paymentMethod']" (ngModelChange)="set('paymentMethod', $event)">
        <option value="">All payment methods</option>
        @for (p of payments; track p) { <option [value]="p">{{ p }}</option> }
      </select>
      <label class="inl">From <input type="date" [ngModel]="f['from']" (ngModelChange)="set('from', $event)" /></label>
      <label class="inl">To <input type="date" [ngModel]="f['to']" (ngModelChange)="set('to', $event)" /></label>
      <select [ngModel]="f['limit']" (ngModelChange)="set('limit', +$event)">
        <option [ngValue]="5">5 / page</option><option [ngValue]="10">10 / page</option><option [ngValue]="25">25 / page</option>
      </select>
      <button class="btn ghost" (click)="clear()">Clear</button>
    </div>

    <div class="card">
      @if (loading()) { <p class="muted">Loading…</p> }
      <table>
        <thead>
          <tr>
            <th class="click" (click)="sort('date')">Date {{ arrow('date') }}</th>
            <th>Category</th><th>Description</th><th>Payment</th>
            <th class="r click" (click)="sort('amount')">Amount {{ arrow('amount') }}</th>
            <th class="r">Actions</th>
          </tr>
        </thead>
        <tbody>
          @for (x of rows(); track x._id) {
            <tr>
              <td>{{ x.date | date:'dd MMM yyyy':'UTC' }}</td>
              <td>{{ x.category?.name }}</td>
              <td>{{ x.description || '—' }}</td>
              <td>{{ x.paymentMethod }}</td>
              <td class="r">{{ x.amount | currency:'INR':'symbol':'1.0-2' }}</td>
              <td class="r">
                <button class="btn sm ghost" (click)="edit(x)">Edit</button>
                <button class="btn sm danger" (click)="remove(x)">Delete</button>
              </td>
            </tr>
          } @empty { <tr><td colspan="6" class="muted">No expenses found.</td></tr> }
        </tbody>
      </table>
      <div class="pager">
        <button class="btn sm ghost" [disabled]="page() <= 1" (click)="go(page() - 1)">‹ Prev</button>
        <span>Page {{ page() }} of {{ pages() }} • {{ total() }} records</span>
        <button class="btn sm ghost" [disabled]="page() >= pages()" (click)="go(page() + 1)">Next ›</button>
      </div>
    </div>
  `,
})
class ExpensesComponent implements OnInit {
  private api = inject(Api);
  private fb = inject(FormBuilder);
  payments = PAYMENT_METHODS;

  cats = signal<Category[]>([]);
  rows = signal<Expense[]>([]);
  total = signal(0);
  pages = signal(1);
  page = signal(1);
  loading = signal(false);
  saving = signal(false);
  msg = signal('');
  error = signal('');
  showForm = signal(false);
  editId = signal<string | null>(null);
  submitted = false;

  f: Record<string, any> = { search: '', category: '', paymentMethod: '', from: '', to: '', sortBy: 'date', order: 'desc', limit: 10 };
  search$ = new Subject<void>();

  form = this.fb.group({
    amount: [null as number | null, [Validators.required, positive]],
    category: ['', Validators.required],
    description: ['', Validators.maxLength(200)],
    date: [todayStr(), [Validators.required, validDate]],
    paymentMethod: ['', Validators.required],
  });

  ngOnInit() {
    this.api.categories().subscribe({ next: (c) => this.cats.set(c), error: (e) => this.error.set(errMsg(e)) });
    this.search$.pipe(debounceTime(400)).subscribe(() => { this.page.set(1); this.load(); });
    this.load();
  }

  load() {
    this.loading.set(true);
    let p = new HttpParams().set('page', this.page()).set('limit', this.f['limit']);
    for (const k of ['search', 'category', 'paymentMethod', 'from', 'to', 'sortBy', 'order']) {
      if (this.f[k]) p = p.set(k, this.f[k]);
    }
    this.api.expenses(p).subscribe({
      next: (r) => {
        this.rows.set(r.data); this.total.set(r.total); this.pages.set(r.pages);
        this.error.set(''); this.loading.set(false);
      },
      error: (e) => { this.error.set(errMsg(e)); this.loading.set(false); },
    });
  }

  set(key: string, val: any) { this.f[key] = val; this.page.set(1); this.load(); }
  clear() {
    this.f = { search: '', category: '', paymentMethod: '', from: '', to: '', sortBy: 'date', order: 'desc', limit: this.f['limit'] };
    this.page.set(1); this.load();
  }
  sort(col: string) {
    if (this.f['sortBy'] === col) this.f['order'] = this.f['order'] === 'asc' ? 'desc' : 'asc';
    else { this.f['sortBy'] = col; this.f['order'] = 'desc'; }
    this.page.set(1); this.load();
  }
  arrow(col: string) { return this.f['sortBy'] === col ? (this.f['order'] === 'asc' ? '▲' : '▼') : ''; }
  go(p: number) { this.page.set(p); this.load(); }

  // ----- form -----
  openForm() {
    this.editId.set(null); this.submitted = false; this.msg.set('');
    this.form.reset({ amount: null, category: '', description: '', date: todayStr(), paymentMethod: '' });
    this.showForm.set(true);
  }
  closeForm() { this.showForm.set(false); this.editId.set(null); }
  edit(x: Expense) {
    this.editId.set(x._id); this.submitted = false; this.msg.set('');
    this.form.reset({
      amount: x.amount, category: x.category?._id ?? '', description: x.description,
      date: x.date.substring(0, 10), paymentMethod: x.paymentMethod,
    });
    this.showForm.set(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  fe(name: string): string {
    const c = this.form.get(name);
    if (!c || !c.errors || !(c.touched || this.submitted)) return '';
    if (c.errors['required']) return 'This field is required';
    if (c.errors['positive']) return 'Amount must be greater than 0';
    if (c.errors['badDate']) return 'Invalid date';
    if (c.errors['maxlength']) return 'Max 200 characters';
    return 'Invalid value';
  }
  save() {
    this.submitted = true;
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const body = this.form.getRawValue();
    const id = this.editId();
    const req = id ? this.api.updateExpense(id, body) : this.api.addExpense(body);
    this.saving.set(true);
    req.subscribe({
      next: () => {
        this.saving.set(false); this.showForm.set(false);
        this.msg.set(id ? 'Expense updated' : 'Expense added'); this.error.set('');
        this.editId.set(null); this.load();
      },
      error: (e) => { this.saving.set(false); this.error.set(errMsg(e)); },
    });
  }
  remove(x: Expense) {
    if (!confirm('Delete this expense?')) return;
    this.api.deleteExpense(x._id).subscribe({
      next: () => {
        if (this.rows().length === 1 && this.page() > 1) this.page.set(this.page() - 1);
        this.msg.set('Expense deleted'); this.error.set(''); this.load();
      },
      error: (e) => this.error.set(errMsg(e)),
    });
  }
}

// ===================== Root + Routing =====================
const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'dashboard', component: DashboardComponent },
  { path: 'expenses', component: ExpensesComponent },
  { path: 'categories', component: CategoriesComponent },
  { path: '**', redirectTo: 'dashboard' },
];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  encapsulation: ViewEncapsulation.None,
  template: `
    <header>
      <div class="brand">💸 Expense Tracker</div>
      <nav>
        <a routerLink="/dashboard" routerLinkActive="active">Dashboard</a>
        <a routerLink="/expenses" routerLinkActive="active">Expenses</a>
        <a routerLink="/categories" routerLinkActive="active">Categories</a>
      </nav>
    </header>
    <main><router-outlet /></main>
  `,
  styles: [`
    *{box-sizing:border-box} body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f1f5f9;color:#0f172a}
    header{background:#312e81;color:#fff;display:flex;gap:24px;align-items:center;padding:12px 24px;flex-wrap:wrap}
    .brand{font-weight:700;font-size:18px} nav a{color:#c7d2fe;text-decoration:none;margin-right:16px;padding:6px 2px}
    nav a.active{color:#fff;border-bottom:2px solid #fff}
    main{max-width:1100px;margin:0 auto;padding:20px}
    h2{margin:0 0 14px} h3{margin:0 0 12px}
    .head{display:flex;justify-content:space-between;align-items:center}
    .card{background:#fff;border-radius:10px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
    .stat{margin:0;display:flex;flex-direction:column;gap:4px} .stat span{color:#64748b;font-size:13px} .stat b{font-size:22px} .stat small{color:#64748b}
    .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
    .chart-box{position:relative;height:300px}
    table{width:100%;border-collapse:collapse} th,td{padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:left;font-size:14px}
    th{color:#475569;font-size:12px;text-transform:uppercase} .r{text-align:right} .click{cursor:pointer;user-select:none}
    input,select{padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;width:100%;background:#fff}
    .btn{background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:9px 16px;cursor:pointer;font-size:14px;margin-right:6px}
    .btn:disabled{opacity:.5;cursor:not-allowed} .btn.ghost{background:#e2e8f0;color:#0f172a}
    .btn.danger{background:#dc2626} .btn.sm{padding:5px 10px;font-size:12px;margin-right:0;margin-left:4px}
    .row{display:flex;gap:10px} .row input{flex:1}
    .filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:center}
    .inl{display:flex;gap:6px;align-items:center;font-size:13px;color:#475569}
    .formgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
    .formgrid label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#475569} .full{grid-column:1/-1}
    .err{color:#dc2626;min-height:14px} .muted{color:#64748b}
    .alert{padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:14px}
    .alert.ok{background:#dcfce7;color:#166534} .alert.bad{background:#fee2e2;color:#991b1b}
    .pager{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:13px;color:#475569}
  `],
})
class RootComponent {}

bootstrapApplication(RootComponent, {
  providers: [provideRouter(routes), provideHttpClient()],
}).catch((err) => console.error(err));