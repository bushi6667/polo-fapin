const fs=require('fs'),assert=require('assert/strict'),vm=require('vm');
const html=fs.readFileSync('发品助手.html','utf8');
for(const value of ['data-tab="audit"','data-tab="steps"','id="tab-audit"','id="tab-steps"','function renderSuiteSteps(','function saveSuiteSteps(','function resetSuiteSteps(','function pickSuiteDir(','function renderPathConfig(','function checkPathPermissions(','polo_suite_steps_v1'])assert(!html.includes(value),value);
for(const value of ['data-tab="basic"','data-tab="highlights"','data-tab="faq"','function openPhotopea(','function loadColorImagesFromExtension(','function startColorChange(','function renderSuiteImages('])assert(html.includes(value),value);
assert(html.includes("['basic','highlights','faq'].includes(savedTab)"));
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const popup=fs.readFileSync('chrome_extension/popup.html','utf8');assert(popup.includes('choose-color-img-dir'));assert(popup.includes('choose-ps-directory'));
console.log('PASS 删除两页与旧配置操作，旧页签回退，颜色图/PS/基础页/扩展目录配置保留，页面脚本语法通过');
