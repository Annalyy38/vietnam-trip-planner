// --- IMPORTS AND CONFIG ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, updateDoc, getDocs, writeBatch, addDoc, deleteDoc, setDoc, serverTimestamp, query, where } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- GLOBAL CONFIGURATION ---
const GOOGLE_SHEET_ID = '1wOKscGP6hXK-qK4yzgGrZDY-AqXsDxsATOuinbDH8iA';
const SHEET_NAMES = {
    CHECKLIST: 'Checklist', TIMELINE: 'Timeline', REC_EAT_DRINK: 'Rec_EatDrink',
    REC_SHOPPING: 'Rec_Shopping', REC_PLACES: 'Rec_Places', CHART_DATA: 'ChartData', EXPENSES: 'Expenses'
};
const EXPENSE_CATEGORIES = {
    'อาหารและเครื่องดื่ม': '#D98880', 'การเดินทาง': '#73C6B6', 'ที่พัก': '#85C1E9',
    'ช้อปปิ้ง': '#F7DC6F', 'ค่าเข้าชม/กิจกรรม': '#BB8FCE', 'อื่นๆ': '#B2BABB'
};

// --- FIREBASE SETUP ---
// IMPORTANT: You will replace this configuration in the next step.
const appId = 'vietnam-trip-planner-2025'; // You can change this to your own unique app name.
const firebaseConfig = { 
    apiKey: "YOUR_API_KEY", 
    authDomain: "YOUR_AUTH_DOMAIN", 
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// --- GLOBAL STATE ---
let currentUserId = null;
let expenseChartInstance = null;
let balanceChartInstance = null;
let allFirestoreData = { timeline: [], recommendations: [], expenses: [] };

// --- UTILITY & HELPER FUNCTIONS ---
const getCollectionRef = (collectionName) => collection(db, `trips/${appId}/${collectionName}`);
const getDocRef = (collectionName, docId) => doc(db, `trips/${appId}/${collectionName}`, docId);

async function fetchGoogleSheetData(sheetName) {
    const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Network response was not ok for sheet: ${sheetName}`);
        const csvText = await response.text();
        const lines = csvText.trim().split(/\r?\n/);
        if (lines.length < 2) return [];
        const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
        return lines.slice(1).map(line => {
            const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
            return headers.reduce((obj, header, i) => {
                if (header) {
                    let value = (values[i] || '').replace(/^"|"$/g, '').trim();
                    if (value.toLowerCase() === 'true') value = true;
                    else if (value.toLowerCase() === 'false') value = false;
                    else if (!isNaN(value) && value.trim() !== '') value = Number(value);
                    obj[header] = value;
                }
                return obj;
            }, {});
        });
    } catch (error) {
        console.error(`Error fetching Google Sheet '${sheetName}':`, error);
        return [];
    }
}

async function populateFirestoreFromSheet(collectionName, sheetData, keyField = null) {
    const collectionRef = getCollectionRef(collectionName);
    const snapshot = await getDocs(collectionRef);
    if (snapshot.empty && sheetData.length > 0) {
        console.log(`Populating Firestore collection '${collectionName}' from Google Sheet...`);
        const batch = writeBatch(db);
        sheetData.forEach(item => {
            const docRef = keyField ? getDocRef(collectionName, item[keyField].toString()) : doc(collectionRef);
            batch.set(docRef, { ...item, isFromSheet: true });
        });
        await batch.commit();
        console.log(`'${collectionName}' populated successfully.`);
    }
}

// --- MODAL MANAGEMENT ---
const backdrop = document.getElementById('modal-backdrop');
const modals = {
    recommendation: document.getElementById('recommendation-modal'),
    expense: document.getElementById('expense-modal'),
    timeline: document.getElementById('timeline-modal'),
    confirm: document.getElementById('confirm-modal')
};

function openModal(modalName) {
    if (modals[modalName]) {
        backdrop.style.display = 'block';
        modals[modalName].style.display = 'block';
    }
}

function closeModal() {
    backdrop.style.display = 'none';
    Object.values(modals).forEach(modal => modal.style.display = 'none');
}

function showConfirmationModal(title, message, onConfirm) {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-message').textContent = message;
    const confirmBtn = document.getElementById('confirm-modal-confirm');
    
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    newConfirmBtn.onclick = () => { onConfirm(); closeModal(); };
    openModal('confirm');
}

// --- RENDER FUNCTIONS ---
function renderChecklist(items) {
    const container = document.getElementById('checklist');
    document.getElementById('checklist-loader').style.display = 'none';
    container.innerHTML = '';
    items.sort((a, b) => a.Order - b.Order).forEach(item => {
        const li = document.createElement('li');
        li.className = item.Checked ? 'checked' : '';
        li.dataset.id = item.id;
        
        const text = item.Text || '';
        const parts = text.split(':');
        const mainText = parts.length > 1 ? `<strong>${parts[0]}:</strong> ${parts.slice(1).join(':').trim()}` : text;

        li.innerHTML = `<i class="checkbox-icon fa-regular ${item.Checked ? 'fa-square-check' : 'fa-square'}"></i><span class="main-text">${mainText}</span>`;
        li.addEventListener('click', () => updateDoc(getDocRef('checklist', item.id), { Checked: !item.Checked }));
        container.appendChild(li);
    });
}

function renderTimeline(items) {
    const container = document.getElementById('timeline-container');
    document.getElementById('timeline-loader').style.display = 'none';
    container.innerHTML = '';
    if (!items) return;

    const groupedByDay = items.reduce((acc, item) => {
        const day = item.Day;
        if (!acc[day]) {
            const baseInfo = items.find(i => i.Day === day);
            acc[day] = { 
                day: day, 
                date: baseInfo?.Date || `Day ${day}`, 
                title: baseInfo?.Title || `Trip Day ${day}`, 
                icon: baseInfo?.Icon || '📅', 
                activities: [] 
            };
        }
        acc[day].activities.push(item);
        return acc;
    }, {});

    const sortedDays = Object.values(groupedByDay).sort((a, b) => a.day - b.day);
    
    const line = document.createElement('div');
    line.className = 'absolute top-0 bottom-0 left-6 md:left-1/2 w-0.5 bg-gray-300 -translate-x-1/2';
    container.appendChild(line);

    sortedDays.forEach((dayData, index) => {
        const isRight = index % 2 !== 0;
        const itemEl = document.createElement('div');
        itemEl.className = `timeline-item relative flex items-start mb-8 md:mb-12 w-full`;
        
        const activitiesHtml = dayData.activities.sort((a,b) => String(a.Time || '').localeCompare(String(b.Time || ''))).map(act => {
            const canEdit = currentUserId && (act.userId === currentUserId || act.isFromSheet);
            const actionsHtml = canEdit ? `
                <div class="action-icon">
                    <button class="edit-btn" data-type="timeline" data-id="${act.id}"><i class="fas fa-pencil-alt"></i></button>
                    <button class="delete-btn" data-type="timeline" data-id="${act.id}"><i class="fas fa-trash-alt"></i></button>
                </div>` : '';
            const mapLink = act.ActivityMapLink ? `<a href="${act.ActivityMapLink}" target="_blank" class="ml-4 text-2xl text-muted-khaki hover:text-soft-terracotta">📍</a>` : '';
            const userBadge = act.userId ? '<span class="user-generated-badge" style="top: -10px; right: -10px;"><i class="fas fa-user-plus"></i></span>' : '';

            return `
            <div class="py-4 border-b border-gray-200/60 last:border-b-0 relative">
                ${actionsHtml}
                ${userBadge}
                <img src="${act.ActivityImage || 'https://placehold.co/600x300/FDF8F0/A8998A?text=Image'}" alt="${act.ActivityTitle}" class="rounded-lg mb-3 object-cover w-full h-48 bg-gray-200" onerror="this.style.display='none';">
                <p class="text-xs text-soft-terracotta font-semibold">${act.Time}</p>
                <div class="flex justify-between items-start mt-1">
                    <div><h4 class="font-semibold text-deep-green">${act.ActivityTitle}</h4><p class="text-sm text-gray-600">${act.ActivityDescription || ''}</p></div>
                    ${mapLink}
                </div>
            </div>`;
        }).join('');

        const addActivityHtml = `
            <div class="mt-4 text-center">
                <button class="add-activity-btn bg-deep-green/10 text-deep-green font-semibold py-2 px-4 rounded-lg hover:bg-deep-green/20 transition-colors w-full" data-day="${dayData.day}">
                    <i class="fas fa-plus mr-2"></i>เพิ่มกิจกรรมสำหรับวันที่ ${dayData.day}
                </button>
            </div>`;

        itemEl.innerHTML = `
            <div class="z-10 absolute top-0 left-6 md:left-1/2 -translate-x-1/2 flex items-center justify-center bg-deep-green shadow-xl w-12 h-12 rounded-full text-white text-lg">${dayData.icon}</div>
            <div class="w-full md:w-1/2 ${isRight ? 'md:ml-auto md:pl-12' : 'md:pr-12'} pl-16 md:pl-0">
                <div class="bg-white/60 rounded-lg shadow-xl px-6 py-4">
                    <div class="timeline-header flex justify-between items-center cursor-pointer">
                        <div>
                            <h3 class="font-bold text-deep-green text-xl">${dayData.title}</h3>
                            <p class="text-sm font-medium text-muted-khaki">${dayData.date}</p>
                        </div>
                        <i class="fas fa-chevron-down text-muted-khaki"></i>
                    </div>
                    <div class="timeline-content mt-4">
                        ${activitiesHtml}
                        ${addActivityHtml}
                    </div>
                </div>
            </div>`;
        container.appendChild(itemEl);
        itemEl.querySelector('.timeline-header').addEventListener('click', (e) => {
            if (!e.target.closest('button')) {
                e.currentTarget.closest('.timeline-item').classList.toggle('open');
            }
        });
    });
}

function renderRecommendations(items) {
    const recContainer = document.getElementById('recommendation-container');
    document.getElementById('recommendation-loader').style.display = 'none';
    recContainer.innerHTML = '';
    const groupedData = items.reduce((acc, item) => {
        const mainCat = item.MainCategory;
        if (!mainCat) return acc;
        if (!acc[mainCat]) acc[mainCat] = {};
        const subCat = item.SubCategory || 'ทั่วไป';
        if (!acc[mainCat][subCat]) acc[mainCat][subCat] = [];
        acc[mainCat][subCat].push(item);
        return acc;
    }, {});

    Object.entries(groupedData).forEach(([mainCatName, mainCatData]) => {
        const box = document.createElement('div');
        box.className = 'bg-white/60 p-4 md:p-6 rounded-2xl shadow-lg';
        box.innerHTML = `<h3 class="text-xl font-bold text-soft-terracotta mb-6 text-center md:text-left">${mainCatName}</h3>
                         <div class="tabs-container flex overflow-x-auto space-x-2 mb-6 border-b border-gray-200/80 pb-3 scroll-container"></div>
                         <div class="panels-container relative"></div>`;
        const tabsContainer = box.querySelector('.tabs-container');
        const panelsContainer = box.querySelector('.panels-container');

        Object.entries(mainCatData).forEach(([subCatName, subCatItems], index) => {
            const tabId = `tab-${mainCatName.replace(/[^a-zA-Z0-9]/g, '')}-${index}`;
            tabsContainer.innerHTML += `<button class="tab-btn px-4 py-2 rounded-full text-sm font-semibold border border-gray-300 flex-shrink-0 bg-white/80 ${index === 0 ? 'active' : ''}" data-target="${tabId}">${subCatName}</button>`;
            
            const cardsHtml = subCatItems.map(item => {
                const canEdit = currentUserId && (item.userId === currentUserId || item.isFromSheet);
                const actionsHtml = canEdit ? `
                    <div class="action-icon">
                        <button class="edit-btn" data-type="recommendation" data-id="${item.id}"><i class="fas fa-pencil-alt"></i></button>
                        <button class="delete-btn" data-type="recommendation" data-id="${item.id}"><i class="fas fa-trash-alt"></i></button>
                    </div>` : '';
                const userBadge = item.userId ? '<span class="user-generated-badge"><i class="fas fa-user-plus"></i></span>' : '';
                return `
                <div class="flex-shrink-0 w-64 md:w-72 bg-white rounded-2xl shadow-md overflow-hidden flex flex-col transition-transform duration-300 hover:scale-105 relative">
                    ${actionsHtml} ${userBadge}
                    <img src="${item.Image || 'https://placehold.co/300x200/FDF8F0/A8998A?text=Image'}" alt="${item.Name}" class="w-full h-36 object-cover bg-gray-200" onerror="this.src='https://placehold.co/300x200/FDF8F0/A8998A?text=Not+Found';">
                    <div class="p-4 flex flex-col flex-grow">
                        <h4 class="font-bold text-deep-green mb-1 text-base">${item.Name}</h4>
                        <p class="text-sm text-gray-600 mb-4 flex-grow">${item.Description}</p>
                        ${item.Link ? `<a href="${item.Link}" target="_blank" class="mt-auto text-sm font-semibold text-soft-terracotta hover:underline self-start">ดูแผนที่ / รีวิว →</a>` : ''}
                    </div>
                </div>`;
            }).join('');
            
            const panel = document.createElement('div');
            panel.id = tabId;
            panel.className = `tab-panel ${index === 0 ? 'active' : ''}`;
            panel.innerHTML = `
                <div class="relative group">
                    <div class="carousel-scroll flex overflow-x-auto space-x-4 p-2 -m-2">
                        ${cardsHtml}
                    </div>
                    <button class="carousel-nav-btn prev absolute top-1/2 -translate-y-1/2 left-0 md:-left-4 opacity-0 group-hover:opacity-100 transition-opacity"><i class="fas fa-chevron-left"></i></button>
                    <button class="carousel-nav-btn next absolute top-1/2 -translate-y-1/2 right-0 md:-right-4 opacity-0 group-hover:opacity-100 transition-opacity"><i class="fas fa-chevron-right"></i></button>
                </div>`;
            
            const scrollContainer = panel.querySelector('.carousel-scroll');
            const prevBtn = panel.querySelector('.prev');
            const nextBtn = panel.querySelector('.next');
            
            prevBtn.addEventListener('click', () => { scrollContainer.scrollBy({ left: -scrollContainer.clientWidth * 0.8, behavior: 'smooth' }); });
            nextBtn.addEventListener('click', () => { scrollContainer.scrollBy({ left: scrollContainer.clientWidth * 0.8, behavior: 'smooth' }); });

            panelsContainer.appendChild(panel);
        });
        
        tabsContainer.addEventListener('click', e => {
            const button = e.target.closest('button');
            if (button) {
                tabsContainer.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                panelsContainer.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === button.dataset.target));
            }
        });
        recContainer.appendChild(box);
    });
}

function renderExpenses(items) {
    document.getElementById('expenses-loader').style.display = 'none';
    document.getElementById('expenses-content').classList.remove('hidden');

    const budgetItem = items.find(item => item.Category === 'Budget');
    const expenseItems = items.filter(item => item.Category !== 'Budget');
    const totalBudget = budgetItem ? budgetItem.Amount : 0;
    const totalSpent = expenseItems.reduce((sum, item) => sum + item.Amount, 0);

    const expensesByCategory = expenseItems.reduce((acc, item) => {
        acc[item.Category] = (acc[item.Category] || 0) + item.Amount;
        return acc;
    }, {});

    const summaryContainer = document.getElementById('expense-category-summary');
    summaryContainer.innerHTML = `
        <div class="flex justify-between items-baseline"><span class="font-semibold text-deep-green">งบทั้งหมด:</span><span class="font-bold text-xl text-deep-green">${totalBudget.toLocaleString('th-TH')} ฿</span></div>
        <div class="flex justify-between items-baseline"><span class="font-semibold text-soft-terracotta">ใช้ไปแล้ว:</span><span class="font-bold text-xl text-soft-terracotta">${totalSpent.toLocaleString('th-TH')} ฿</span></div>
        <hr class="my-2 border-gray-300">`;
    Object.entries(expensesByCategory).sort((a, b) => b[1] - a[1]).forEach(([category, amount]) => {
        const color = EXPENSE_CATEGORIES[category] || '#A8998A';
        summaryContainer.innerHTML += `<div class="flex justify-between items-center text-sm"><span class="flex items-center"><span class="w-3 h-3 rounded-full mr-2" style="background-color: ${color};"></span>${category}</span><span class="font-semibold">${amount.toLocaleString('th-TH')} ฿</span></div>`;
    });

    const listContainer = document.getElementById('expense-list-details');
    listContainer.innerHTML = expenseItems.length === 0 ? `<li class="text-center text-muted-khaki">ยังไม่มีรายการค่าใช้จ่าย</li>` : 
        expenseItems.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).map(item => {
            const canEdit = currentUserId && (item.userId === currentUserId || item.isFromSheet);
            const actionsHtml = canEdit ? `
                <button class="edit-btn" data-type="expense" data-id="${item.id}"><i class="fas fa-pencil-alt"></i></button>
                <button class="delete-btn" data-type="expense" data-id="${item.id}"><i class="fas fa-trash-alt"></i></button>` : '<div class="w-12"></div>';
            return `<li class="flex justify-between items-center bg-white/50 p-3 rounded-lg">
                        <div><p class="font-semibold text-deep-green">${item.Item}</p><p class="text-sm text-muted-khaki">${item.Category}</p></div>
                        <div class="flex items-center space-x-3">
                            <p class="font-semibold text-soft-terracotta w-24 text-right">${item.Amount.toLocaleString('th-TH')} ฿</p>
                            ${actionsHtml}
                        </div>
                    </li>`;
        }).join('');
    
    renderExpenseChart(expensesByCategory);
}

function renderExpenseChart(data) {
    const ctx = document.getElementById('expenseChart')?.getContext('2d');
    if (!ctx) return;
    const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]);
    const chartData = {
        labels: sorted.map(e => e[0]),
        datasets: [{
            data: sorted.map(e => e[1]),
            backgroundColor: sorted.map(e => EXPENSE_CATEGORIES[e[0]] || '#A8998A'),
            borderColor: '#FDF8F0', borderWidth: 4,
        }]
    };
    if (expenseChartInstance) {
        expenseChartInstance.data = chartData;
        expenseChartInstance.update();
    } else {
        expenseChartInstance = new Chart(ctx, { type: 'doughnut', data: chartData, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } });
    }
}

function renderBalanceChart(data) {
    const ctx = document.getElementById('balanceChart')?.getContext('2d');
    if (!ctx || !data || data.length === 0) { document.getElementById('chart-loader').innerHTML = 'ไม่สามารถโหลดข้อมูลกราฟได้'; return; };
    document.getElementById('chart-loader').style.display = 'none';
    if (balanceChartInstance) balanceChartInstance.destroy();
    balanceChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(d => d.Label),
            datasets: [
                { label: 'ชั่วโมงเที่ยว', data: data.map(d => d.TravelHours), backgroundColor: '#C87E6A', borderRadius: 5 },
                { label: 'ชั่วโมงพัก', data: data.map(d => d.RestHours), backgroundColor: '#3D5A52', borderRadius: 5 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, stacked: true }, x: { stacked: true } }, plugins: { legend: { position: 'bottom' } } }
    });
}

// --- DATA LISTENERS ---
function setupDataListeners() {
    onSnapshot(getCollectionRef('checklist'), snapshot => {
        const items = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderChecklist(items);
    });
    
    onSnapshot(getCollectionRef('timeline'), snapshot => {
        allFirestoreData.timeline = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTimeline(allFirestoreData.timeline);
    });

    onSnapshot(getCollectionRef('recommendations'), snapshot => {
        allFirestoreData.recommendations = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderRecommendations(allFirestoreData.recommendations);
    });

    onSnapshot(getCollectionRef('expenses'), snapshot => {
        allFirestoreData.expenses = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderExpenses(allFirestoreData.expenses);
    });
}

// --- EVENT HANDLERS & SETUP ---
function updateSubCategoryDatalist(mainCategory) {
    const subCategoryDatalist = document.getElementById('sub-category-list');
    if (!subCategoryDatalist) return;

    const existingSubCategories = new Set(
        allFirestoreData.recommendations
            .filter(rec => rec.MainCategory === mainCategory && rec.SubCategory)
            .map(rec => rec.SubCategory)
    );

    subCategoryDatalist.innerHTML = [...existingSubCategories]
        .map(subCat => `<option value="${subCat}"></option>`)
        .join('');
}

function setupEventListeners() {
    // Modal general controls
    document.querySelectorAll('.modal-cancel-btn').forEach(btn => btn.addEventListener('click', closeModal));
    backdrop.addEventListener('click', closeModal);
    document.getElementById('confirm-modal-cancel').addEventListener('click', closeModal);

    // Add item buttons
    document.getElementById('add-rec-btn').addEventListener('click', () => {
        const form = document.getElementById('recommendation-form');
        form.reset();
        form.elements['docId'].value = '';
        updateSubCategoryDatalist(form.elements['MainCategory'].value);
        openModal('recommendation');
    });
    document.getElementById('add-expense-btn').addEventListener('click', () => {
        document.getElementById('expense-form').reset();
        document.getElementById('exp-doc-id').value = '';
        openModal('expense');
    });
    
    document.getElementById('rec-main-category').addEventListener('change', (e) => {
        updateSubCategoryDatalist(e.target.value);
    });

    // Form submissions
    document.getElementById('recommendation-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('expense-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('timeline-form').addEventListener('submit', handleFormSubmit);

    // Dynamic event listeners for edit/delete/add
    document.body.addEventListener('click', e => {
        const target = e.target.closest('button');
        if (!target) return;

        const { type, id, day } = target.dataset;

        if (target.classList.contains('delete-btn')) {
            handleDelete(type, id);
        } else if (target.classList.contains('edit-btn')) {
            handleEdit(type, id);
        } else if (target.classList.contains('add-activity-btn')) {
            const form = document.getElementById('timeline-form');
            form.reset();
            form.elements['docId'].value = '';
            form.elements['Day'].value = day;
            openModal('timeline');
        }
    });
}

async function handleFormSubmit(e) {
    e.preventDefault();
    if (!currentUserId) return;
    
    const form = e.target;
    const formData = new FormData(form);
    const docId = formData.get('docId');
    let data = Object.fromEntries(formData.entries());
    delete data.docId;

    let collectionName;
    if (form.id === 'recommendation-form') {
        collectionName = 'recommendations';
    } else if (form.id === 'expense-form') {
        collectionName = 'expenses';
        data.Amount = Number(data.Amount);
    } else if (form.id === 'timeline-form') {
        collectionName = 'timeline';
        if (!docId) {
            const baseInfo = allFirestoreData.timeline.find(i => i.Day == data.Day);
            if (baseInfo) {
                data.Date = baseInfo.Date;
                data.Title = baseInfo.Title;
                data.Icon = baseInfo.Icon;
            }
        }
    }

    try {
        if (docId) { // Update existing doc
            await updateDoc(getDocRef(collectionName, docId), data);
        } else { // Add new doc
            data.userId = currentUserId;
            data.createdAt = serverTimestamp();
            await addDoc(getCollectionRef(collectionName), data);
        }
        closeModal();
        form.reset();
    } catch (error) {
        console.error("Error saving document:", error);
    }
}

function handleDelete(type, id) {
    const collectionName = (type === 'timeline') ? 'timeline' : (type === 'recommendation' ? 'recommendations' : 'expenses');
    showConfirmationModal('ยืนยันการลบ', 'คุณต้องการลบรายการนี้ใช่หรือไม่?', async () => {
        try {
            await deleteDoc(getDocRef(collectionName, id));
        } catch (error) {
            console.error("Error deleting document:", error);
        }
    });
}

function handleEdit(type, id) {
    let item, formId, modalName;
    if (type === 'timeline') {
        item = allFirestoreData.timeline.find(i => i.id === id);
        formId = 'timeline-form';
        modalName = 'timeline';
    } else if (type === 'recommendation') {
        item = allFirestoreData.recommendations.find(i => i.id === id);
        formId = 'recommendation-form';
        modalName = 'recommendation';
    } else if (type === 'expense') {
        item = allFirestoreData.expenses.find(i => i.id === id);
        formId = 'expense-form';
        modalName = 'expense';
    }

    if (item) {
        const form = document.getElementById(formId);
        form.reset();
        Object.keys(item).forEach(key => {
            const input = form.elements[key];
            if (input) {
                input.value = item[key];
            }
        });
        form.elements['docId'].value = id;
        
        if (type === 'recommendation') {
            updateSubCategoryDatalist(item.MainCategory);
            form.elements['SubCategory'].value = item.SubCategory;
        }
        
        openModal(modalName);
    }
}

// --- MAIN APP INITIALIZATION ---
async function main() {
    setupEventListeners();
    
    const [checklistData, timelineSheetData, chartData, expenseData, recEatData, recShopData, recPlaceData] = await Promise.all([
        fetchGoogleSheetData(SHEET_NAMES.CHECKLIST), fetchGoogleSheetData(SHEET_NAMES.TIMELINE),
        fetchGoogleSheetData(SHEET_NAMES.CHART_DATA), fetchGoogleSheetData(SHEET_NAMES.EXPENSES),
        fetchGoogleSheetData(SHEET_NAMES.REC_EAT_DRINK), fetchGoogleSheetData(SHEET_NAMES.REC_SHOPPING),
        fetchGoogleSheetData(SHEET_NAMES.REC_PLACES)
    ]);
    
    const allRecsData = [
        ...recEatData.map(i => ({ ...i, MainCategory: 'กิน & ดื่ม 😋' })),
        ...recShopData.map(i => ({ ...i, MainCategory: 'ช้อป & เดินตลาด 🛍️' })),
        ...recPlaceData.map(i => ({ ...i, MainCategory: 'พักผ่อน & สถานที่ 🏞️' }))
    ];
    
    renderBalanceChart(chartData);

    onAuthStateChanged(auth, async (user) => {
        const authStatusEl = document.getElementById('auth-status');
        if (user) {
            currentUserId = user.uid;
            authStatusEl.innerHTML = `<i class="fas fa-check-circle text-green-500"></i> คุณกำลังวางแผนร่วมกับเพื่อนๆ (ID: ${currentUserId.substring(0, 8)})`;
            
            await Promise.all([
                populateFirestoreFromSheet('checklist', checklistData, 'Order'),
                populateFirestoreFromSheet('timeline', timelineSheetData),
                populateFirestoreFromSheet('recommendations', allRecsData),
                populateFirestoreFromSheet('expenses', expenseData)
            ]);
            setupDataListeners();

        } else {
            authStatusEl.innerText = 'กำลังเชื่อมต่อเพื่อการทำงานร่วมกัน...';
            try {
                // For local development or environments without a pre-set token
                await signInAnonymously(auth);
            } catch (error) {
                console.error("Authentication failed:", error);
                authStatusEl.innerHTML = `<i class="fas fa-exclamation-triangle text-red-500"></i> ไม่สามารถเชื่อมต่อโหมดทำงานร่วมกันได้`;
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', main);