'use strict';

// Variables available in any text: {name} {owner}
function defaultFlow() {
  return {
    version: 1,
    root: {
      id: 'root',
      type: 'menu',
      title: 'الرئيسية',
      text:
        'أهلاً {name} 👋\n' +
        'أنا *المساعد الشخصي* لـ {owner}، أرد عنه وأرتب رسائله وأتذكر محادثاتنا.\n' +
        'اكتب رقم الخيار الذي تريده:',
      children: [
        {
          id: 'consent1',
          type: 'consent',
          title: 'تحليل رسالتي وإرسالها للمهندس',
          text: 'هل توافق أن أقوم بتحليل رسائلك وتحويلها إلى {owner} حسب ما تريد، وأن يصلك منا ما يستجد من إعلانات؟',
          yesLabel: 'موافق',
          noLabel: 'غير موافق',
          yesText: '✅ شكراً {name}، تم تسجيل موافقتك.',
          noText: 'تم تسجيل عدم موافقتك، لن نرسل لك أي إعلانات.',
        },
        {
          id: 'works',
          type: 'menu',
          title: 'أعمالي',
          text: 'نبذة عن أعمال {owner}:',
          children: [
            { id: 'works1', type: 'text', title: 'المشاريع', text: 'هنا تكتب قائمة مشاريعك. عدّل هذا النص من لوحة التحكم.' },
            { id: 'works2', type: 'text', title: 'الخدمات', text: 'هنا تكتب الخدمات التي تقدمها. عدّل هذا النص من لوحة التحكم.' },
          ],
        },
        {
          id: 'private',
          type: 'forward',
          title: 'رسالة خاصة للمهندس',
          text: '✍️ اكتب رسالتك الآن وسأوصلها إلى {owner} بشكل خاص.',
        },
        {
          id: 'intro',
          type: 'ask',
          title: 'عرّفني عليك',
          text: '',
          questions: [
            { key: 'nickname', text: 'ما الاسم الذي تحب أن أناديك به؟' },
            { key: 'about', text: 'عرّفني بنفسك باختصار (عملك أو اهتمامك):' },
          ],
          afterText: 'تشرفت بمعرفتك يا {name} 🤝 سأتذكرك في كل محادثة.',
        },
        {
          id: 'ai',
          type: 'ai',
          title: 'تحدث مع المساعد الذكي',
          text: '🤖 أنا جاهز للإجابة عن أسئلتك. اكتب سؤالك، وأرسل 0 للخروج.',
        },
      ],
    },
  };
}

module.exports = { defaultFlow };
