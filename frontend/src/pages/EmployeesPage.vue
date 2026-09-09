<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import ReferenceTable from "../components/ReferenceTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";

const rows=ref([]),loading=ref(true),error=ref(""),detail=ref(null),saving=ref(false),formError=ref(""),invitation=ref("");
const filters=ref({search:"",active:"1"});
const options=reactive({entities:[],points:[],positions:[]});
const form=reactive({});
const accessForm=reactive({access_profile:"Cashier",points:[]});
const uploading=ref(""),lookingUpBank=ref(false),generatingDocs=ref(false);
const columns=[
 {key:"employee_name",label:"Сотрудник",primary:true},
 {key:"phone",label:"Телефон"},
 {key:"position",label:"Должность"},
 {key:"business_entity",label:"Работодатель"},
 {key:"employment_type",label:"Оформление"},
 {key:"access",label:"Доступ",format:(value)=>value?(value.active?`${labelProfile(value.access_profile)} · активен`:"Отключён"):"Не выдан"},
];
const filterFields=[
 {key:"search",label:"Поиск",placeholder:"ФИО или телефон",wide:true},
 {key:"active",label:"Статус",type:"select",allLabel:"Все",options:[{value:"1",label:"Работают"},{value:"0",label:"Уволены / архив"}]},
];
const availablePoints=computed(()=>options.points.filter(p=>!form.business_entity||p.business_entity===form.business_entity));
const selectedPoints=computed(()=>(form.assigned_points||[]).map(x=>x.business_point));
const employeePoints=computed(()=>availablePoints.value.filter(p=>selectedPoints.value.includes(p.name)));
function labelProfile(v){return v==="Point Manager"?"Управляющий":"Кассир";}
function reset(values={}){
 Object.keys(form).forEach(k=>delete form[k]);
 Object.assign(form,{active:1,employment_type:"Трудовой договор",assigned_points:[],documents:[],...values});
 accessForm.access_profile="Cashier";accessForm.points=[];invitation.value="";formError.value="";
}
async function load(){loading.value=true;error.value="";try{rows.value=await call("raspechatka.api.team.get_employee_registry",filters.value)}catch(e){error.value=e.message}finally{loading.value=false}}
async function create(){reset();try{const r=await call("raspechatka.api.team.get_employee_editor");Object.assign(options,r);detail.value={access:null}}catch(e){error.value=e.message}}
async function open(row){try{const r=await call("raspechatka.api.team.get_employee_editor",{name:row.name});Object.assign(options,r);detail.value=r;reset(JSON.parse(JSON.stringify(r.employee)));if(r.access){accessForm.access_profile=r.access.access_profile;accessForm.points=(r.access.assigned_points||[]).map(x=>x.business_point)}}catch(e){error.value=e.message}}
function togglePoint(point){
 const list=form.assigned_points||(form.assigned_points=[]),i=list.findIndex(x=>x.business_point===point.name);
 if(i>=0)list.splice(i,1);else list.push({business_point:point.name,is_default:list.length?0:1});
 accessForm.points=accessForm.points.filter(x=>(form.assigned_points||[]).some(p=>p.business_point===x));
}
function toggleAccessPoint(name){const i=accessForm.points.indexOf(name);if(i>=0)accessForm.points.splice(i,1);else accessForm.points.push(name)}
async function save(){
 saving.value=true;formError.value="";
 try{const check=await call("raspechatka.api.hr_documents.validate_employee_requisites",{data:JSON.stringify(form)},{method:"POST"});if(!check.valid)throw new Error(check.errors.join(". "));const r=await call("raspechatka.api.team.save_employee",{data:JSON.stringify(form)},{method:"POST"});await load();await open({name:r.name})}
 catch(e){formError.value=e.message}finally{saving.value=false}
}
async function grant(){
 saving.value=true;formError.value="";
 try{const r=await call("raspechatka.api.team.grant_employee_access",{employee:form.name,access_profile:accessForm.access_profile,assigned_points:JSON.stringify(accessForm.points)},{method:"POST"});invitation.value=r.message;await load();await refreshAccess()}
 catch(e){formError.value=e.message}finally{saving.value=false}
}
async function refreshAccess(){const r=await call("raspechatka.api.team.get_employee_editor",{name:form.name});detail.value.access=r.access}
async function setAccess(active){
 try{await call("raspechatka.api.team.set_employee_access_active",{employee:form.name,active},{method:"POST"});await Promise.all([refreshAccess(),load()])}
 catch(e){formError.value=e.message}
}
async function uploadPassport(event,field){
 const file=event.target.files?.[0];if(!file)return;
 if(!form.name){formError.value="Сначала сохраните карточку сотрудника, затем прикрепите паспорт.";return}
 if(file.type!=="application/pdf"){formError.value="Для паспорта прикрепите файл PDF.";return}
 uploading.value=field;formError.value="";
 try{
  const body=new FormData();body.append("file",file);body.append("is_private","1");body.append("doctype","Employee");body.append("docname",form.name);body.append("fieldname",field);
  const response=await fetch("/api/method/upload_file",{method:"POST",headers:{"X-Frappe-CSRF-Token":window.csrf_token||""},body,credentials:"same-origin"});
  const result=await response.json();if(!response.ok||result.exc)throw new Error(result.message||"Не удалось загрузить файл");
  form[field]=result.message.file_url;await save();
 }catch(e){formError.value=e.message}finally{uploading.value=""}
}
async function lookupBank(){
 lookingUpBank.value=true;formError.value="";
 try{Object.assign(form,await call("raspechatka.api.hr_documents.lookup_employee_bank",{bic:form.salary_bic}))}
 catch(e){formError.value=`${e.message} Реквизиты можно заполнить вручную.`}
 finally{lookingUpBank.value=false}
}
async function generateDocuments(){
 generatingDocs.value=true;formError.value="";
 try{const result=await call("raspechatka.api.hr_documents.generate_employment_documents",{employee:form.name},{method:"POST"});if(!result.count)throw new Error("Комплект этой версии уже сформирован.");await open({name:form.name})}
 catch(e){formError.value=e.message}finally{generatingDocs.value=false}
}
async function copyInvitation(){await navigator.clipboard.writeText(invitation.value)}
onMounted(load);
</script>

<template>
<section class="page employee-page">
 <ListPageHeader title="Сотрудники"><template #actions><button class="button button-primary" @click="create">＋ Создать сотрудника</button></template></ListPageHeader>
 <SmartFilterBar v-model="filters" :fields="filterFields" view-key="team.employees" @apply="load" @reset="load"/>
 <ReferenceTable :rows="rows" :columns="columns" view-key="team.employees" :loading="loading" :error="error" @open="open" @retry="load"/>
 <AppModal v-if="detail!==null" title="Карточка сотрудника" wide @close="detail=null">
  <form class="editor-form" @submit.prevent="save">
   <div class="form-section"><h3>Сотрудник</h3><div class="form-grid">
    <label>Фамилия<input v-model="form.last_name" required></label>
    <label>Имя<input v-model="form.first_name" required></label>
    <label>Отчество<input v-model="form.middle_name"></label>
    <label>Телефон<input v-model="form.phone" type="tel" required></label>
    <label>Email<input v-model="form.email" type="email"></label>
    <label>Дата рождения<input v-model="form.birth_date" type="date"></label>
    <label>Пол<select v-model="form.gender"><option value="">Не указан</option><option>Женский</option><option>Мужской</option></select></label>
    <label class="check-field"><input v-model="form.active" type="checkbox" :true-value="1" :false-value="0"> Работает</label>
   </div></div>
   <div class="form-section"><h3>Трудоустройство</h3><div class="form-grid">
    <label>Работодатель — ИП<select v-model="form.business_entity" required><option value="">Выберите</option><option v-for="e in options.entities" :key="e.name" :value="e.name">{{e.short_name}}</option></select></label>
    <label>Должность<select v-model="form.position" required><option value="">Выберите</option><option v-for="p in options.positions" :key="p.name" :value="p.name">{{p.position_name}}</option></select></label>
    <label>Тип оформления<select v-model="form.employment_type" required><option>Трудовой договор</option><option>ГПХ</option><option>Самозанятый</option><option>ИП</option><option>Без оформления</option></select></label>
    <label>Дата приёма<input v-model="form.hire_date" type="date"></label>
    <label>Дата увольнения<input v-model="form.dismissal_date" type="date"></label>
   </div>
   <h4>Точки работы</h4><div class="point-picker"><label v-for="p in availablePoints" :key="p.name"><input type="checkbox" :checked="selectedPoints.includes(p.name)" @change="togglePoint(p)"> {{p.point_name}}</label></div>
   </div>
   <div class="form-section"><h3>Данные для трудоустройства</h3><div class="form-grid">
    <label>ИНН<input v-model="form.inn" inputmode="numeric" maxlength="12"></label>
    <label>СНИЛС<input v-model="form.snils" inputmode="numeric" maxlength="14"></label>
    <label>Серия паспорта<input v-model="form.passport_series" inputmode="numeric" maxlength="4"></label>
    <label>Номер паспорта<input v-model="form.passport_number" inputmode="numeric" maxlength="6"></label>
    <label>Дата выдачи<input v-model="form.passport_issue_date" type="date"></label>
    <label>Код подразделения<input v-model="form.passport_department_code" placeholder="000-000"></label>
    <label class="span-3">Кем выдан<textarea v-model="form.passport_issued_by" rows="2"></textarea></label>
    <label class="span-3">Адрес регистрации<textarea v-model="form.registration_address" rows="2"></textarea></label>
   </div></div>
   <div class="form-section"><h3>Паспорт — файлы</h3><p class="section-note">Прикрепляются два отдельных PDF. Для загрузки сначала сохраните новую карточку.</p><div class="document-grid">
    <label><b>Основная страница</b><a v-if="form.passport_main_file" :href="form.passport_main_file" target="_blank">Открыть текущий файл</a><input type="file" accept="application/pdf" :disabled="!form.name||uploading" @change="uploadPassport($event,'passport_main_file')"><span v-if="uploading==='passport_main_file'">Загрузка…</span></label>
    <label><b>Страница регистрации</b><a v-if="form.passport_registration_file" :href="form.passport_registration_file" target="_blank">Открыть текущий файл</a><input type="file" accept="application/pdf" :disabled="!form.name||uploading" @change="uploadPassport($event,'passport_registration_file')"><span v-if="uploading==='passport_registration_file'">Загрузка…</span></label>
   </div></div>
   <div class="form-section"><h3>Банковские реквизиты для зарплаты</h3><div class="form-grid">
    <label class="span-2">Получатель<input v-model="form.salary_recipient_name" :placeholder="form.employee_name"></label>
    <label>БИК<div class="field-with-action"><input v-model="form.salary_bic" inputmode="numeric" maxlength="9"><button class="button button-secondary" type="button" :disabled="lookingUpBank||!form.salary_bic" @click="lookupBank">{{lookingUpBank?"Ищем…":"Заполнить по БИК"}}</button></div></label>
    <label class="span-2">Банк<input v-model="form.salary_bank_name"></label>
    <label>Корреспондентский счёт<input v-model="form.salary_correspondent_account" inputmode="numeric" maxlength="20"></label>
    <label class="span-2">Счёт получателя<input v-model="form.salary_account" inputmode="numeric" maxlength="20"></label>
   </div></div>
   <div v-if="form.name" class="form-section"><div class="documents-heading"><div><h3>Документы трудоустройства</h3><p class="section-note">Комплект формируется из актуальных шаблонов и сохраняется приватно в карточке.</p></div><button class="button button-primary" type="button" :disabled="generatingDocs" @click="generateDocuments">{{generatingDocs?"Формируем…":"Сформировать документы для найма"}}</button></div>
    <div v-if="form.documents?.length" class="generated-documents"><a v-for="item in form.documents" :key="item.name||item.file" :href="item.file" target="_blank"><b>{{item.document_type}}</b><span>{{item.status}} · {{item.issue_date}}</span><small>{{item.notes}}</small></a></div>
    <p v-else class="section-note">Сформированных документов пока нет.</p>
   </div>
   <div v-if="form.name" class="form-section access-section"><div class="access-title"><div><h3>Доступ в систему</h3><p v-if="!detail.access">Сотрудник учитывается в графике и зарплате без учётной записи.</p><p v-else>{{labelProfile(detail.access.access_profile)}} · {{detail.access.active?"доступ активен":"доступ отключён"}} · {{detail.access.invitation_status}}</p></div></div>
    <template v-if="!detail.access">
     <div class="form-grid"><label>Профиль<select v-model="accessForm.access_profile"><option value="Cashier">Кассир</option><option value="Point Manager">Управляющий точкой</option></select></label></div>
     <h4>Разрешённые точки</h4><div class="point-picker"><label v-for="p in employeePoints" :key="p.name"><input type="checkbox" :checked="accessForm.points.includes(p.name)" @change="toggleAccessPoint(p.name)"> {{p.point_name}}</label></div>
     <button type="button" class="button button-primary" :disabled="saving||!accessForm.points.length" @click="grant">Выдать доступ и создать приглашение</button>
    </template>
    <template v-else><div class="security-actions"><button v-if="!detail.access.active" type="button" class="button" @click="setAccess(1)">Восстановить доступ</button><button v-else type="button" class="button" @click="setAccess(0)">Отключить доступ</button><button type="button" class="button button-primary" @click="grant">Создать новую ссылку входа</button></div></template>
    <div v-if="invitation" class="invitation"><textarea :value="invitation" rows="6" readonly></textarea><button type="button" class="button" @click="copyInvitation">Копировать сообщение</button></div>
   </div>
   <p v-if="formError" class="form-error">{{formError}}</p>
  </form>
  <template #footer><div class="footer-actions"><button class="button" @click="detail=null">Закрыть</button><button class="button button-primary" :disabled="saving" @click="save">{{saving?"Сохраняем…":"Сохранить сотрудника"}}</button></div></template>
 </AppModal>
</section>
</template>

<style scoped>
.point-picker{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 16px}.point-picker label{display:flex;align-items:center;gap:7px;border:1px solid #dfe6d8;border-radius:9px;padding:9px 12px;background:#fff}.access-section{border:1px solid #dfe9d6;border-radius:12px;background:#f8fbf5;padding:16px}.access-title h3{margin:0}.access-title p{margin:5px 0 14px;color:#6f7d68}.security-actions{display:flex;gap:10px;flex-wrap:wrap}.invitation{display:grid;gap:10px;margin-top:14px}.invitation textarea{width:100%;resize:vertical}.form-section h4{margin:14px 0 6px}.footer-actions{display:flex;gap:10px;margin-left:auto}.section-note{color:#74806f;margin:-4px 0 12px}.document-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.document-grid label{display:grid;gap:8px;border:1px solid #e1e7dc;border-radius:10px;padding:14px}.document-grid a{color:#4f7d2d;font-size:13px}.documents-heading{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.generated-documents{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.generated-documents a{display:grid;gap:4px;padding:12px;border:1px solid #dfe7d9;border-radius:9px;color:inherit;text-decoration:none}.generated-documents span,.generated-documents small{color:#6d7768;font-size:12px}.document-grid input{padding:8px;border:1px dashed #cfd9c7;border-radius:8px}@media(max-width:700px){.document-grid,.generated-documents{grid-template-columns:1fr}.documents-heading{flex-direction:column}}
</style>
