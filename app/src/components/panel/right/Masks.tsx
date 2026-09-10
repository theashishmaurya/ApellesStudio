import {
  PaintBrushIcon,
  PerspectiveIcon,
  CircleIcon,
  CloudIcon,
  DropIcon,
  WavesIcon,
  EraserIcon,
  CursorClickIcon,
  RectangleIcon,
  GradientIcon,
  UserIcon,
  SunIcon,
  StampIcon,
  BandaidsIcon,
  BezierCurveIcon,
  BroomIcon,
} from '@phosphor-icons/react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import Text from '../../ui/Text';
import { TextWeights } from '../../../types/typography';
import i18n from 'i18next';

export enum Mask {
  AiDepth = 'ai-depth',
  AiForeground = 'ai-foreground',
  AiSky = 'ai-sky',
  AiSubject = 'ai-subject',
  All = 'all',
  Brush = 'brush',
  Flow = 'flow',
  Color = 'color',
  Linear = 'linear',
  Luminance = 'luminance',
  QuickEraser = 'quick-eraser',
  Radial = 'radial',
  Clone = 'clone',
  Heal = 'heal',
  Liquify = 'liquify',
  Retouch = 'retouch',
}

export enum SubMaskMode {
  Additive = 'additive',
  Subtractive = 'subtractive',
  Intersect = 'intersect',
}

export enum ToolType {
  AiSeletor = 'ai-selector',
  Brush = 'brush',
  Eraser = 'eraser',
  GenerativeReplace = 'generative-replace',
  SelectSubject = 'select-subject',
}

export interface MaskType {
  disabled: boolean;
  icon: any;
  id?: string;
  name: string;
  type: Mask;
}

export interface SubMask {
  id: string;
  invert: boolean;
  mode: SubMaskMode;
  name?: string;
  opacity: number;
  parameters?: any;
  type: Mask;
  visible: boolean;
}

export function formatMaskTypeName(type: string) {
  if (type === Mask.AiDepth) return i18n.t('masks.types.depth');
  if (type === Mask.AiSubject) return i18n.t('masks.types.subject');
  if (type === Mask.AiForeground) return i18n.t('masks.types.foreground');
  if (type === Mask.AiSky) return i18n.t('masks.types.sky');
  if (type === Mask.All) return i18n.t('masks.types.all');
  if (type === Mask.QuickEraser) return i18n.t('masks.types.quickEraser');
  if (type === Mask.Brush) return i18n.t('masks.types.brush');
  if (type === Mask.Flow) return i18n.t('masks.types.flow');
  if (type === Mask.Color) return i18n.t('masks.types.color');
  if (type === Mask.Linear) return i18n.t('masks.types.linear');
  if (type === Mask.Luminance) return i18n.t('masks.types.luminance');
  if (type === Mask.Radial) return i18n.t('masks.types.radial');
  if (type === Mask.Clone) return i18n.t('masks.types.clone');
  if (type === Mask.Heal) return i18n.t('masks.types.heal');
  if (type === Mask.Liquify) return i18n.t('masks.types.liquify');
  if (type === Mask.Retouch) return i18n.t('masks.types.retouch');
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function getMaskTypeName(mask: MaskType) {
  if (mask.id === 'others') return i18n.t('masks.types.others');
  if (mask.type === Mask.QuickEraser && mask.name === 'Quick Erase') {
    return i18n.t('masks.types.quickErase');
  }
  return formatMaskTypeName(mask.type);
}

export function getSubMaskName(subMask: Pick<SubMask, 'name' | 'type'>) {
  return subMask.name?.trim() || formatMaskTypeName(subMask.type);
}

export const MASK_ICON_MAP: Record<Mask, any> = {
  [Mask.AiDepth]: PerspectiveIcon,
  [Mask.AiForeground]: UserIcon,
  [Mask.AiSky]: CloudIcon,
  [Mask.AiSubject]: CursorClickIcon,
  [Mask.All]: RectangleIcon,
  [Mask.Brush]: PaintBrushIcon,
  [Mask.Flow]: WavesIcon,
  [Mask.Color]: DropIcon,
  [Mask.Linear]: GradientIcon,
  [Mask.Luminance]: SunIcon,
  [Mask.QuickEraser]: EraserIcon,
  [Mask.Radial]: CircleIcon,
  [Mask.Clone]: StampIcon,
  [Mask.Heal]: BandaidsIcon,
  [Mask.Liquify]: BezierCurveIcon,
  [Mask.Retouch]: BroomIcon,
};

export const MASK_AI_TYPES: Array<MaskType> = [
  { disabled: false, icon: CursorClickIcon, name: 'Subject', type: Mask.AiSubject },
  { disabled: false, icon: CloudIcon, name: 'Sky', type: Mask.AiSky },
  { disabled: false, icon: UserIcon, name: 'Foreground', type: Mask.AiForeground },
  { disabled: false, icon: PerspectiveIcon, name: 'Depth', type: Mask.AiDepth },
];

export const MASK_BASIC_TYPES: Array<MaskType> = [
  { disabled: false, icon: PaintBrushIcon, name: 'Brush', type: Mask.Brush },
  { disabled: false, icon: GradientIcon, name: 'Linear', type: Mask.Linear },
  { disabled: false, icon: CircleIcon, name: 'Radial', type: Mask.Radial },
  { disabled: false, icon: WavesIcon, name: 'Flow', type: Mask.Flow },
];

export const MASK_RANGE_TYPES: Array<MaskType> = [
  { disabled: false, icon: DropIcon, name: 'Color', type: Mask.Color },
  { disabled: false, icon: SunIcon, name: 'Luminance', type: Mask.Luminance },
  { disabled: false, icon: RectangleIcon, name: 'Whole Image', type: Mask.All },
];

export const ALL_MASK_TYPES = [...MASK_AI_TYPES, ...MASK_BASIC_TYPES, ...MASK_RANGE_TYPES];

export const AI_DIRECT_PATCH_TYPES: Array<MaskType> = [
  {
    disabled: false,
    icon: StampIcon,
    name: 'Clone',
    type: Mask.Clone,
  },
  {
    disabled: false,
    icon: BandaidsIcon,
    name: 'Heal',
    type: Mask.Heal,
  },
];

export const AI_TOUCH_UP_TYPES: Array<MaskType> = [
  {
    disabled: false,
    icon: BezierCurveIcon,
    name: 'Liquify',
    type: Mask.Liquify,
  },
  {
    disabled: false,
    icon: BroomIcon,
    name: 'Retouch',
    type: Mask.Retouch,
  },
];

export const AI_GENERATIVE_CREATION_TYPES: Array<MaskType> = [
  {
    disabled: false,
    icon: EraserIcon,
    name: 'Quick Erase',
    type: Mask.QuickEraser,
  },
  {
    disabled: false,
    icon: CursorClickIcon,
    name: 'Subject',
    type: Mask.AiSubject,
  },
  {
    disabled: false,
    icon: UserIcon,
    name: 'Foreground',
    type: Mask.AiForeground,
  },
  {
    disabled: false,
    icon: PaintBrushIcon,
    name: 'Brush',
    type: Mask.Brush,
  },
  {
    disabled: false,
    icon: GradientIcon,
    name: 'Linear',
    type: Mask.Linear,
  },
  {
    disabled: false,
    icon: CircleIcon,
    name: 'Radial',
    type: Mask.Radial,
  },
];

export const OTHERS_MASK_TYPES: Array<MaskType> = [
  {
    disabled: false,
    icon: PerspectiveIcon,
    name: 'Depth',
    type: Mask.AiDepth,
  },
  {
    disabled: false,
    icon: DropIcon,
    name: 'Color',
    type: Mask.Color,
  },
  {
    disabled: false,
    icon: SunIcon,
    name: 'Luminance',
    type: Mask.Luminance,
  },
  {
    disabled: false,
    icon: PaintBrushIcon,
    name: 'Brush',
    type: Mask.Brush,
  },
  {
    disabled: false,
    icon: WavesIcon,
    name: 'Flow',
    type: Mask.Flow,
  },
  {
    disabled: false,
    icon: RectangleIcon,
    name: 'Whole Image',
    type: Mask.All,
  },
];

export const AI_SUB_MASK_COMPONENT_TYPES: Array<MaskType> = [
  ...AI_DIRECT_PATCH_TYPES,
  ...AI_TOUCH_UP_TYPES,
  ...AI_GENERATIVE_CREATION_TYPES,
];

export function NewMaskDropZone({ isOver, textKey }: { isOver: boolean; textKey: string }) {
  const { t } = useTranslation();
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0, marginTop: 0 }}
      animate={{ opacity: 1, height: 'auto', marginTop: '4px' }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={`p-3 rounded-lg text-center ${isOver ? 'border border-accent/80 bg-bg-tertiary/50' : ''}`}
    >
      <Text weight={TextWeights.medium}>{t(textKey)}</Text>
    </motion.div>
  );
}
